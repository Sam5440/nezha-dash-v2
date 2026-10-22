import http from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.MOCK_NEZHA_PORT || 8008);
const serverCount = Number(process.env.MOCK_NEZHA_COUNT || 3000);
const updateIntervalMs = Number(
	process.env.MOCK_NEZHA_INTERVAL_MS || (serverCount > 10_000 ? 0 : 2000),
);
const dayMs = 86_400_000;
const minuteMs = 60_000;
const timezoneOffsetMs = 8 * 60 * minuteMs;
const startedAt = Math.floor(Date.now() / 1000) * 1000;

// 前几个节点提供固定 UI 场景；其余节点保留每 17 个离线一个的规则。
const isServerOffline = (id) => id === 3 || id === 4 || id % 17 === 0;

const countries = [
	"US",
	"SG",
	"JP",
	"DE",
	"GB",
	"FR",
	"NL",
	"CA",
	"AU",
	"BR",
	"IN",
	"KR",
	"HK",
	"TW",
	"FI",
	"PL",
];

const platforms = ["linux", "debian", "ubuntu", "centos", "alpine", "Windows"];

const nowIso = () => new Date().toISOString();

function createServer(index) {
	const id = index + 1;
	const platform = platforms[index % platforms.length];
	const memTotal = 2 ** 30 * (2 + (index % 15));
	const diskTotal = 2 ** 30 * (40 + (index % 200));
	const swapTotal = 2 ** 30 * (index % 8);
	const memUsed = memTotal * ((index % 90) / 100);
	const diskUsed = diskTotal * ((index % 84) / 100);
	const swapUsed = swapTotal ? swapTotal * ((index % 60) / 100) : 0;
	const isOffline = isServerOffline(id);

	return {
		id,
		name: `mock-server-${String(id).padStart(4, "0")}`,
		public_note: id % 19 === 0 ? "[[Plan]] bandwidth=1Gbps" : "",
		last_active: isOffline
			? new Date(
					startedAt - (id === 4 ? 31 * dayMs : 10 * minuteMs),
				).toISOString()
			: nowIso(),
		country_code: countries[index % countries.length],
		host: {
			platform,
			platform_version: platform === "Windows" ? "Server 2022" : "6.8",
			cpu: [`Mock CPU ${1 + (index % 8)} Core`],
			gpu: index % 40 === 0 ? ["Mock GPU"] : [],
			mem_total: memTotal,
			disk_total: diskTotal,
			swap_total: swapTotal,
			arch: index % 5 === 0 ? "arm64" : "amd64",
			boot_time: Math.floor(Date.now() / 1000) - 86_400 * (1 + (index % 365)),
			version: "mock-1.0.0",
		},
		state: {
			cpu: (index * 7) % 100,
			mem_used: memUsed,
			swap_used: swapUsed,
			disk_used: diskUsed,
			net_in_transfer: 2 ** 30 * (index % 500),
			net_out_transfer: 2 ** 30 * ((index * 2) % 500),
			net_in_speed: 1024 * (20 + ((index * 13) % 80_000)),
			net_out_speed: 1024 * (20 + ((index * 17) % 80_000)),
			uptime: 3600 * (1 + (index % 20_000)),
			load_1: Number(((index % 100) / 20).toFixed(2)),
			load_5: Number(((index % 80) / 20).toFixed(2)),
			load_15: Number(((index % 60) / 20).toFixed(2)),
			tcp_conn_count: index % 300,
			udp_conn_count: index % 80,
			process_count: 40 + (index % 240),
			temperatures: [],
			gpu: index % 40 === 0 ? [(index * 3) % 100] : [],
		},
	};
}

const servers = Array.from({ length: serverCount }, (_, index) =>
	createServer(index),
);
let onlineCount = servers.filter(
	(server) => !isServerOffline(server.id),
).length;

function updateServerMetrics() {
	const now = Date.now();
	let nextOnlineCount = 0;

	for (const server of servers) {
		const isOffline = isServerOffline(server.id);
		if (!isOffline) {
			server.last_active = new Date(now).toISOString();
			nextOnlineCount += 1;
		}

		const wave = (now / 1000 + server.id) % 100;
		server.state.cpu = Number(wave.toFixed(2));
		server.state.net_in_speed =
			1024 * (20 + ((server.id * 13 + now / 1000) % 80_000));
		server.state.net_out_speed =
			1024 * (20 + ((server.id * 17 + now / 1000) % 80_000));
		server.state.net_in_transfer += server.state.net_in_speed;
		server.state.net_out_transfer += server.state.net_out_speed;
	}

	onlineCount = nextOnlineCount;
}

function websocketPayload() {
	const payload = { now: Date.now() };

	if (onlineCount > 0) {
		payload.online = onlineCount;
	}
	if (servers.length > 0) {
		payload.servers = servers;
	}

	return JSON.stringify(payload);
}

function jsonResponse(response, data, statusCode = 200) {
	response.writeHead(statusCode, {
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(data));
}

function createOnlineHistory(server, days) {
	const windowEnd = Math.floor(Date.now() / 1000) * 1000;
	const windowStart = windowEnd - days * dayMs;
	const firstDay =
		Math.floor((windowStart + timezoneOffsetMs) / dayMs) * dayMs -
		timezoneOffsetMs;
	const currentlyOnline = !isServerOffline(server.id);
	const onlineEnd = currentlyOnline
		? windowEnd
		: Date.parse(server.last_active);
	const periods = [];
	const daily = [];

	const addPeriod = (start, end) => {
		if (end <= start) return;
		periods.push({
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
			ongoing: currentlyOnline && end === windowEnd,
		});
	};

	// 1/6: 日常短暂掉线；2: 持续在线；3: 当前离线；4: 无历史；5: 密集短时段。
	// 先生成离线间隙，再取补集，跨午夜的在线会话保持连续。
	if (server.id !== 4) {
		let cursor = windowStart;
		for (let day = firstDay; day < onlineEnd; day += dayMs) {
			if (server.id === 2) continue;
			const dayIndex = Math.floor((day + timezoneOffsetMs) / dayMs);
			const hours =
				server.id === 5
					? [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
					: [2, 8, 15];
			for (const hour of hours) {
				const gapStart = Math.max(windowStart, day + hour * 60 * minuteMs);
				const gapMinutes =
					server.id === 5 ? 35 : 10 + ((dayIndex + server.id + hour) % 6) * 13;
				// 最后活跃前半小时保持在线，让时段终点与 WebSocket 状态一致。
				const gapEnd = Math.min(
					day + (hour * 60 + gapMinutes) * minuteMs,
					onlineEnd - 30 * minuteMs,
				);
				if (gapEnd <= gapStart) continue;
				addPeriod(cursor, gapStart);
				cursor = gapEnd;
			}
		}
		addPeriod(cursor, onlineEnd);
	}

	// 每日数字和概要都从同一组时段计算，避免时间轴与统计不一致。
	for (let day = firstDay; day < windowEnd; day += dayMs) {
		const onlineSeconds = periods.reduce((total, period) => {
			const start = Math.max(day, Date.parse(period.start));
			const end = Math.min(day + dayMs, Date.parse(period.end));
			return total + Math.max(0, (end - start) / 1000);
		}, 0);
		daily.push({
			date: new Date(day + timezoneOffsetMs).toISOString().slice(0, 10),
			online_seconds: onlineSeconds,
		});
	}
	const totalOnlineSeconds = daily.reduce(
		(total, day) => total + day.online_seconds,
		0,
	);

	return {
		server_id: server.id,
		server_name: server.name,
		days,
		max_days: 30,
		timezone: "Asia/Shanghai",
		window_start: new Date(windowStart).toISOString(),
		window_end: new Date(windowEnd).toISOString(),
		total_online_seconds: totalOnlineSeconds,
		online_rate:
			(totalOnlineSeconds / ((windowEnd - windowStart) / 1000)) * 100,
		currently_online: currentlyOnline,
		last_active:
			server.id === 4 ? undefined : new Date(onlineEnd).toISOString(),
		periods,
		daily,
	};
}

const populatedServerGroups = [
	{
		group: {
			id: 1,
			created_at: nowIso(),
			updated_at: nowIso(),
			name: "Region US/EU",
		},
		servers:
			serverCount > 10_000
				? []
				: servers
						.filter((server) =>
							["US", "DE", "GB", "FR", "NL"].includes(server.country_code),
						)
						.map((server) => server.id),
	},
	{
		group: {
			id: 2,
			created_at: nowIso(),
			updated_at: nowIso(),
			name: "Region APAC",
		},
		servers:
			serverCount > 10_000
				? []
				: servers
						.filter((server) =>
							["SG", "JP", "KR", "HK", "TW", "AU"].includes(
								server.country_code,
							),
						)
						.map((server) => server.id),
	},
];
const serverGroups = serverCount === 0 ? [] : populatedServerGroups;

const serviceHistory = Array.from({ length: 30 }, (_, index) => ({
	up: 95 + (index % 6),
	down: index % 13 === 0 ? 1 : 0,
	delay: 20 + index * 3,
}));

const services =
	serverCount === 0
		? {}
		: {
				mock_http: {
					service_name: "Mock HTTP",
					current_up: 1,
					current_down: 0,
					total_up: 2999,
					total_down: 1,
					delay: serviceHistory.map((item) => item.delay),
					up: serviceHistory.map((item) => item.up),
					down: serviceHistory.map((item) => item.down),
				},
			};

const httpServer = http.createServer((request, response) => {
	const requestUrl = new URL(
		request.url || "/",
		`http://${request.headers.host}`,
	);

	if (request.method === "OPTIONS") {
		response.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		});
		response.end();
		return;
	}

	const onlineHistoryMatch = requestUrl.pathname.match(
		/^\/api\/v1\/server\/(\d+)\/online-history$/,
	);
	if (onlineHistoryMatch) {
		const server = servers[Number(onlineHistoryMatch[1]) - 1];
		const days = Number(requestUrl.searchParams.get("days") ?? 7);
		if (!server) {
			jsonResponse(
				response,
				{ success: false, error: "server not found" },
				404,
			);
			return;
		}
		if (!Number.isInteger(days) || days < 1 || days > 30) {
			jsonResponse(
				response,
				{ success: false, error: "days must be an integer between 1 and 30" },
				400,
			);
			return;
		}
		jsonResponse(response, {
			success: true,
			data: createOnlineHistory(server, days),
		});
		return;
	}

	switch (requestUrl.pathname) {
		case "/api/v1/setting":
			jsonResponse(response, {
				success: true,
				data: {
					config: {
						debug: true,
						language: "en-US",
						site_name: `Nezha Mock ${serverCount}`,
						user_template: "",
						admin_template: "",
						custom_code: "",
					},
					version: "mock-1.0.0",
				},
			});
			return;
		case "/api/v1/server-group":
			jsonResponse(response, { success: true, data: serverGroups });
			return;
		case "/api/v1/service":
			jsonResponse(response, {
				success: true,
				data: {
					services,
					cycle_transfer_stats: {},
				},
			});
			return;
		case "/api/v1/profile":
			jsonResponse(response, {
				success: true,
				data: {
					id: 1,
					username: "mock-user",
					password: "",
					created_at: nowIso(),
					updated_at: nowIso(),
				},
			});
			return;
		default:
			jsonResponse(response, { success: true, data: [] });
	}
});

const websocketServer = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
	if (!request.url?.startsWith("/api/v1/ws/server")) {
		socket.destroy();
		return;
	}

	websocketServer.handleUpgrade(request, socket, head, (websocket) => {
		websocketServer.emit("connection", websocket, request);
	});
});

websocketServer.on("connection", (websocket) => {
	websocket.send(websocketPayload());
});

if (updateIntervalMs > 0) {
	setInterval(() => {
		updateServerMetrics();
		const payload = websocketPayload();
		for (const client of websocketServer.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(payload);
			}
		}
	}, updateIntervalMs);
}

httpServer.listen(port, () => {
	console.log(
		`Mock Nezha API listening on http://localhost:${port} with ${serverCount} servers`,
	);
	if (updateIntervalMs === 0) {
		console.log(
			"Mock Nezha websocket is in static mode. Set MOCK_NEZHA_INTERVAL_MS to enable repeated full-payload updates.",
		);
	}
});
