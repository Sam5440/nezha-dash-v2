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
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

		expect(
			await screen.findByText("serverOnlineHistory.dailyOnline"),
		).toBeInTheDocument();
		expect(screen.getByText("online")).toBeInTheDocument();
		expect(screen.getByText("0.9%")).toBeInTheDocument();
		// 总时长、2026-10-13 日行、第一个时间段时长均为 5400s
		expect(screen.getAllByText("1h 30m").length).toBe(3);
		expect(screen.getByText("2026-10-13")).toBeInTheDocument();
		expect(screen.getByText("2026-10-14")).toBeInTheDocument();
		// 进行中 Badge 精确匹配；时间段行的箭头表明进行中会话已渲染
		expect(screen.getByText("serverOnlineHistory.ongoing")).toBeInTheDocument();
		expect(screen.getAllByText(/→/).length).toBe(2);
	});

	it("maps each day's periods onto the shared 0:00-24:00 timeline", async () => {
		apiMocks.fetchServerOnlineHistory.mockResolvedValue(
			onlineHistoryResponse(),
		);

		renderWithQuery(<ServerDetailOnlineHistory server_id="7" />);

		expect(await screen.findByText("0:00")).toBeInTheDocument();
		expect(screen.getByText("12:00")).toBeInTheDocument();
		expect(screen.getByText("24:00")).toBeInTheDocument();

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
});
