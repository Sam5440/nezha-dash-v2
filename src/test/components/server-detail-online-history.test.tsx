import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ServerDetailOnlineHistory from "@/components/ServerDetailOnlineHistory";
import { createTestQueryClient } from "@/test/utils";
import type { OnlineHistoryResponse } from "@/types/nezha-api";

const apiMocks = vi.hoisted(() => ({
	fetchServerOnlineHistory: vi.fn(),
}));

vi.mock("@/lib/nezha-api", () => ({
	fetchServerOnlineHistory: apiMocks.fetchServerOnlineHistory,
}));

function onlineHistoryResponse(maxDays = 30): OnlineHistoryResponse {
	return {
		success: true,
		data: {
			server_id: 7,
			server_name: "edge-online",
			days: 7,
			max_days: maxDays,
			window_start: "2026-10-07T04:00:00.000Z",
			window_end: "2026-10-14T04:00:00.000Z",
			total_online_seconds: 5400,
			online_rate: 0.89,
			currently_online: true,
			last_active: "2026-10-14T03:30:00.000Z",
			periods: [
				{
					start: "2026-10-13T08:00:00.000Z",
					end: "2026-10-13T09:30:00.000Z",
					ongoing: false,
				},
				{
					start: "2026-10-14T10:00:00.000Z",
					end: "2026-10-14T11:00:00.000Z",
					ongoing: true,
				},
			],
			daily: [
				{ date: "2026-10-13", online_seconds: 5400 },
				{ date: "2026-10-14", online_seconds: 3600 },
			],
		},
	};
}

function renderWithQuery(ui: ReactElement) {
	return render(
		<QueryClientProvider client={createTestQueryClient()}>
			{ui}
		</QueryClientProvider>,
	);
}

describe("ServerDetailOnlineHistory", () => {
	beforeEach(() => {
		apiMocks.fetchServerOnlineHistory.mockReset();
	});

	it("renders the loading state while history data is unavailable", () => {
		apiMocks.fetchServerOnlineHistory.mockReturnValue(
			new Promise(() => undefined),
		);

		const { container } = renderWithQuery(
			<ServerDetailOnlineHistory server_id="7" />,
		);

		expect(container.querySelector(".h-\\[250px\\]")).toBeInTheDocument();
		expect(apiMocks.fetchServerOnlineHistory).toHaveBeenCalledWith(7, 7);
	});

	it("renders summary, daily breakdown, and periods from the API", async () => {
		const user = userEvent.setup();
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

		expect(
			await screen.findByText("serverOnlineHistory.dailyOnline"),
		).toBeInTheDocument();
		// 概要状态灯 + 最近一天组头各一次 "online"
		expect(screen.getAllByText("online")).toHaveLength(2);
		expect(screen.getByText("0.9%")).toBeInTheDocument();
		// 时间段卡默认只显示最近一天：汇总与 2026-10-13 日行各一次 1h 30m
		expect(screen.getAllByText("1h 30m")).toHaveLength(2);
		// 2026-10-14 组：日行、组头合计与 chip 时长均为 3600s
		expect(screen.getAllByText("1h 0m")).toHaveLength(3);
		expect(screen.queryByText("10-13")).not.toBeInTheDocument();
		// 展开更多后显示 2026-10-13 分组（组头 + chip 各一次 1h 30m）
		await user.click(screen.getByText("serverOnlineHistory.expandMore"));
		expect(screen.getByText("10-13")).toBeInTheDocument();
		expect(screen.getAllByText("1h 30m")).toHaveLength(4);
		expect(screen.getAllByText(/→/).length).toBe(2);
	});

	it("maps each day's periods onto the shared 0:00-24:00 timeline", async () => {
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

		expect(await screen.findByText("0:00 – 24:00")).toBeInTheDocument();

		// 每个时间段按当日起点换算为百分比坐标（与时区无关）
		const segments = await screen.findAllByTestId("online-segment");
		expect(segments).toHaveLength(2);
		const dayStart = dayjs("2026-10-13").startOf("day");
		const startPct =
			(dayjs("2026-10-13T08:00:00.000Z").diff(dayStart, "second") / 86400) *
			100;
		const widthPct =
			(dayjs("2026-10-13T09:30:00.000Z").diff(
				"2026-10-13T08:00:00.000Z",
				"second",
			) /
				86400) *
			100;
		expect(Number.parseFloat(segments[0].style.left)).toBeCloseTo(
			Math.max(0, startPct),
			2,
		);
		expect(Number.parseFloat(segments[0].style.width)).toBeCloseTo(
			Math.min(100, widthPct),
			2,
		);
		expect(segments[0].style.minWidth).toBe("2px");
	});

	it("renders the compact mobile summary below the md breakpoint", async () => {
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(),
		);
		vi.stubGlobal(
			"matchMedia",
			vi.fn().mockImplementation(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
		try {
			renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

			expect(await screen.findByTestId("summary-mobile")).toBeInTheDocument();
			expect(screen.queryByTestId("summary-desktop")).not.toBeInTheDocument();
			// 移动端：大数字 + 双信息盒（合计在线 / 最近活跃）
			expect(screen.getByText("0.9%")).toBeInTheDocument();
			expect(
				screen.getByText("serverOnlineHistory.totalOnline"),
			).toBeInTheDocument();
			expect(
				screen.getByText("serverOnlineHistory.lastActive"),
			).toBeInTheDocument();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("switches the query window via the day selector", async () => {
		const user = userEvent.setup();
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);
		await screen.findByText("serverOnlineHistory.dailyOnline");

		await user.click(screen.getByText("serverOnlineHistory.days30"));

		await waitFor(() => {
			expect(apiMocks.fetchServerOnlineHistory).toHaveBeenCalledWith(7, 30);
		});
	});

	it("locks day options beyond the configured max window", async () => {
		const user = userEvent.setup();
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(7),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);
		await screen.findByText("serverOnlineHistory.dailyOnline");

		await user.click(screen.getByText("serverOnlineHistory.days30"));
		expect(apiMocks.fetchServerOnlineHistory).toHaveBeenCalledTimes(1);
		expect(apiMocks.fetchServerOnlineHistory).toHaveBeenCalledWith(7, 7);
	});

	it("shows the login hint when the API rejects anonymous guests", async () => {
		apiMocks.fetchServerOnlineHistory.mockRejectedValue(
			new Error("unauthorized: only 1d data available for guests"),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

		expect(
			await screen.findByText("serverOnlineHistory.loginRequired"),
		).toBeInTheDocument();
	});

	it("falls back to one day and retries automatically for guests", async () => {
		const user = userEvent.setup();
		apiMocks.fetchServerOnlineHistory
			.mockRejectedValueOnce(
				new Error("unauthorized: only 1d data available for guests"),
			)
			.mockResolvedValue(onlineHistoryResponse());

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

		// 首次 7d 被拒后自动以 1d 重试并渲染数据
		await screen.findByText("serverOnlineHistory.dailyOnline");
		await waitFor(() => {
			expect(apiMocks.fetchServerOnlineHistory).toHaveBeenNthCalledWith(
				2,
				7,
				1,
			);
		});

		// 更长窗口被锁定（游客上限 1 天），点击不再发起新请求
		const calls = apiMocks.fetchServerOnlineHistory.mock.calls.length;
		await user.click(screen.getByText("serverOnlineHistory.days30"));
		expect(apiMocks.fetchServerOnlineHistory).toHaveBeenNthCalledWith(2, 7, 1);
		expect(apiMocks.fetchServerOnlineHistory.mock.calls.length).toBe(calls);
	});

	it("groups periods by the panel timezone from the response", async () => {
		const data = onlineHistoryResponse().data;
		// 面板时区非 UTC 才能暴露 dayjs .tz(input, zone) 忽略显式偏移的问题
		data.timezone = "Asia/Shanghai";
		data.daily = [{ date: "2026-01-02", online_seconds: 7200 }];
		data.periods = [
			{
				start: "2026-01-01T20:00:00.000Z",
				end: "2026-01-01T22:00:00.000Z",
				ongoing: false,
			},
		];
		apiMocks.fetchServerOnlineHistory.mockResolvedValue({
			success: true,
			data,
		});

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);
		await screen.findByText("serverOnlineHistory.dailyOnline");

		// 20:00Z 在面板时区（UTC+8）为 01-02 04:00：分组落到 01-02，段内时刻同步换算
		expect(screen.getByText("01-02")).toBeInTheDocument();
		expect(screen.queryByText("01-01")).not.toBeInTheDocument();
		const chip = screen.getByTestId("period-chip");
		expect(chip.textContent).toContain("04:00");
		expect(chip.textContent).toContain("06:00");
	});

	it("expands online periods ten days per click starting from the latest day", async () => {
		const user = userEvent.setup();
		const data = onlineHistoryResponse().data;
		const dates = Array.from({ length: 25 }, (_, i) =>
			dayjs("2026-10-14").subtract(i, "day").format("YYYY-MM-DD"),
		);
		data.daily = dates.map((date) => ({ date, online_seconds: 3600 }));
		data.periods = dates.map((date) => ({
			start: `${date}T06:00:00.000Z`,
			end: `${date}T07:00:00.000Z`,
			ongoing: false,
		}));
		apiMocks.fetchServerOnlineHistory.mockResolvedValue({
			success: true,
			data,
		});

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);
		await screen.findByText("serverOnlineHistory.dailyOnline");

		expect(screen.getAllByTestId("period-day")).toHaveLength(1);

		await user.click(screen.getByText("serverOnlineHistory.expandMore"));
		expect(screen.getAllByTestId("period-day")).toHaveLength(11);

		await user.click(screen.getByText("serverOnlineHistory.expandMore"));
		expect(screen.getAllByTestId("period-day")).toHaveLength(21);

		await user.click(screen.getByText("serverOnlineHistory.expandMore"));
		expect(screen.getAllByTestId("period-day")).toHaveLength(25);
		expect(
			screen.queryByText("serverOnlineHistory.expandMore"),
		).not.toBeInTheDocument();
	});

	it("derives offline periods as the complement of online sessions", async () => {
		const user = userEvent.setup();
		const data = onlineHistoryResponse().data;
		data.window_start = "2026-10-14T00:00:00.000Z";
		data.window_end = "2026-10-14T12:00:00.000Z";
		data.currently_online = false;
		data.daily = [{ date: "2026-10-14", online_seconds: 7200 }];
		data.periods = [
			{
				start: "2026-10-14T02:00:00.000Z",
				end: "2026-10-14T04:00:00.000Z",
				ongoing: false,
			},
		];
		apiMocks.fetchServerOnlineHistory.mockResolvedValue({
			success: true,
			data,
		});

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);
		await screen.findByText("serverOnlineHistory.dailyOnline");

		await user.click(screen.getByText("serverOnlineHistory.periodsOffline"));

		// 在线 02:00-04:00 两侧的空档各成一段，且服务器当前离线 → 末段进行中
		const chips = screen.getAllByTestId("period-chip");
		expect(chips).toHaveLength(2);
		expect(chips[1].textContent).toContain("serverOnlineHistory.ongoing");

		// 组头合计 = 窗口截断时长 − 当日在线时长（按时区计算，与时区无关）
		const windowSeconds = dayjs("2026-10-14T12:00:00.000Z").diff(
			dayjs("2026-10-14").startOf("day"),
			"second",
		);
		const totalSeconds = windowSeconds - 7200;
		const h = Math.floor(totalSeconds / 3600);
		const m = Math.floor((totalSeconds % 3600) / 60);
		const expected = h > 0 ? `${h}h ${m}m` : `${m}m`;
		expect(screen.getByText(expected)).toBeInTheDocument();
	});
});
