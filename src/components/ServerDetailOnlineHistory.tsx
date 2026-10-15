import { keepPreviousData, useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import NetworkChartLoading from "@/components/NetworkChartLoading";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActiveIndicator } from "@/hooks/use-active-indicator";
import { fetchServerOnlineHistory } from "@/lib/nezha-api";
import { cn } from "@/lib/utils";
import type { DailyOnlineStat, OnlinePeriod } from "@/types/nezha-api";

dayjs.extend(utc);
dayjs.extend(timezone);

const DAY_OPTIONS = [1, 7, 30];
// Online periods 默认只展开最近 1 天，每次「展开更多」追加 10 天
const PERIODS_INITIAL_DAYS = 1;
const PERIODS_EXPAND_STEP = 10;

type PeriodMode = "online" | "offline";

type PeriodChip = {
	start: dayjs.Dayjs;
	end: dayjs.Dayjs;
	ongoing: boolean;
};

type PeriodDayGroup = {
	date: string;
	day: dayjs.Dayjs;
	total: number;
	chips: PeriodChip[];
};

// 后端按面板时区拆日；响应带 timezone 时前端用同一时区解释时间，
// 保证跨时区访客的时间轴、分组与每日数字一致
function panelDay(value: string, tz?: string): dayjs.Dayjs {
	// dayjs 的 .tz(input, zone) 解析模式会忽略输入里的显式偏移（Z / ±HH:MM）：
	// 带偏移的时间戳须先按原义解析再换算时区，无偏移的日期串才用 zone 解析
	if (tz) {
		return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
			? dayjs(value).tz(tz)
			: dayjs.tz(value, tz);
	}
	return dayjs(value);
}

function panelNow(tz?: string): dayjs.Dayjs {
	return tz ? dayjs().tz(tz) : dayjs();
}

function formatDuration(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) {
		return `${d}d ${h}h ${m}m`;
	}
	if (h > 0) {
		return `${h}h ${m}m`;
	}
	return `${m}m`;
}

// 把一天映射到 0:00–24:00 整轴：裁剪出该日与每个时间段的交集，
// 换算成轨道内的百分比坐标。
function buildDaySegments(periods: OnlinePeriod[], date: string, tz?: string) {
	const dayStart = panelDay(date, tz);
	const dayEnd = dayStart.add(1, "day");
	return periods
		.map((period) => {
			const start = panelDay(period.start, tz);
			const end = panelDay(period.end, tz);
			const segStart = start.isAfter(dayStart) ? start : dayStart;
			const segEnd = end.isBefore(dayEnd) ? end : dayEnd;
			const leftPct = Math.max(
				0,
				(segStart.diff(dayStart, "second") / 86400) * 100,
			);
			const widthPct = Math.min(
				Math.max(0, (segEnd.diff(segStart, "second") / 86400) * 100),
				100 - leftPct,
			);
			return { period, segStart, segEnd, leftPct, widthPct };
		})
		.filter((segment) => segment.widthPct > 0);
}

// 合并重叠/相邻的时间段，按开始时间排序
function mergePeriods(periods: OnlinePeriod[], tz?: string): PeriodChip[] {
	const sorted = periods
		.map((period) => ({
			start: panelDay(period.start, tz),
			end: panelDay(period.end, tz),
			ongoing: period.ongoing,
		}))
		.sort((a, b) => a.start.valueOf() - b.start.valueOf());
	const merged: PeriodChip[] = [];
	for (const period of sorted) {
		const last = merged[merged.length - 1];
		if (last && period.start.isBefore(last.end)) {
			if (period.end.isAfter(last.end)) {
				last.end = period.end;
			}
			last.ongoing = last.ongoing || period.ongoing;
		} else {
			merged.push({ ...period });
		}
	}
	return merged;
}

// 在线模式：按开始日分组（跨天时段归入开始日），合计优先取接口的当日在线秒数
function groupOnlinePeriods(
	periods: OnlinePeriod[],
	daily: DailyOnlineStat[],
	tz?: string,
): PeriodDayGroup[] {
	const secondsByDate = new Map(
		daily.map((day) => [day.date, day.online_seconds]),
	);
	const byDate = new Map<string, PeriodChip[]>();
	for (const period of periods) {
		const date = panelDay(period.start, tz).format("YYYY-MM-DD");
		const chip: PeriodChip = {
			start: panelDay(period.start, tz),
			end: panelDay(period.end, tz),
			ongoing: period.ongoing,
		};
		const chips = byDate.get(date);
		if (chips) {
			chips.push(chip);
		} else {
			byDate.set(date, [chip]);
		}
	}
	return [...byDate.entries()]
		.sort((a, b) => (a[0] < b[0] ? 1 : -1))
		.map(([date, chips]) => ({
			date,
			day: panelDay(date, tz),
			total:
				secondsByDate.get(date) ??
				chips.reduce(
					(sum, chip) => sum + chip.end.diff(chip.start, "second"),
					0,
				),
			chips,
		}));
}

// 离线模式：对窗口内每一天求在线时段的补集；服务器当前离线时，最新一天的末段标记为进行中
function buildOfflineGroups(
	periods: OnlinePeriod[],
	daily: DailyOnlineStat[],
	windowEnd: string,
	currentlyOnline: boolean,
	tz?: string,
): PeriodDayGroup[] {
	const merged = mergePeriods(periods, tz);
	const secondsByDate = new Map(
		daily.map((day) => [day.date, day.online_seconds]),
	);
	const windowEndTime = panelDay(windowEnd, tz);
	const groups: PeriodDayGroup[] = daily
		.map((day) => day.date)
		.sort((a, b) => (a < b ? 1 : -1))
		.map((date) => {
			const dayStart = panelDay(date, tz);
			const dayEnd = dayStart.add(1, "day");
			const clippedEnd = dayEnd.isAfter(windowEndTime) ? windowEndTime : dayEnd;
			const chips: PeriodChip[] = [];
			let cursor = dayStart;
			for (const segment of merged) {
				if (segment.end.isBefore(cursor) || !segment.end.isAfter(dayStart)) {
					continue;
				}
				const segStart = segment.start.isAfter(dayStart)
					? segment.start
					: dayStart;
				if (segStart.isAfter(cursor)) {
					chips.push({ start: cursor, end: segStart, ongoing: false });
				}
				const segEnd = segment.end.isBefore(clippedEnd)
					? segment.end
					: clippedEnd;
				if (segEnd.isAfter(cursor)) {
					cursor = segEnd;
				}
			}
			if (cursor.isBefore(clippedEnd)) {
				chips.push({ start: cursor, end: clippedEnd, ongoing: false });
			}
			const windowSeconds = clippedEnd.diff(dayStart, "second");
			const total = Math.max(
				0,
				windowSeconds -
					(secondsByDate.get(date) ??
						chips.reduce(
							(sum, chip) => sum + chip.end.diff(chip.start, "second"),
							0,
						)),
			);
			return { date, day: dayStart, total, chips };
		})
		.filter((group) => group.chips.length > 0);
	if (!currentlyOnline && groups.length > 0) {
		const newest = groups[0].chips;
		if (newest.length > 0) {
			newest[newest.length - 1].ongoing = true;
		}
	}
	return groups;
}

function DaysSelector({
	selectedDays,
	maxDays,
	onDaysChange,
}: {
	selectedDays: number;
	maxDays: number;
	onDaysChange: (days: number) => void;
}) {
	const { t } = useTranslation();
	const { containerRef, enableIndicatorAnimation, indicator, setItemRef } =
		useActiveIndicator<number>(DAY_OPTIONS, selectedDays);

	return (
		<div
			ref={containerRef}
			className="relative flex gap-0.5 mb-3 flex-wrap p-0.5 bg-muted dark:bg-muted/40 rounded-full w-fit border border-border/60 dark:border-border"
		>
			{indicator && (
				<div
					className="active-indicator-fade-in absolute left-0 top-0 z-10 bg-white dark:bg-background rounded-full ring-1 ring-border/60 dark:ring-border/40"
					style={{
						height: indicator.height,
						transform: `translate(${indicator.x}px, ${indicator.y}px)`,
						transition: indicator.shouldAnimate
							? "transform 0.5s var(--timing), width 0.5s var(--timing), height 0.5s var(--timing)"
							: "none",
						width: indicator.width,
					}}
				/>
			)}
			{DAY_OPTIONS.map((days, index) => {
				const isLocked = days > maxDays;
				return (
					<div
						key={days}
						ref={setItemRef(index)}
						onClick={() => {
							if (!isLocked) {
								if (selectedDays !== days) {
									enableIndicatorAnimation();
								}
								onDaysChange(days);
							}
						}}
						className={cn(
							"relative z-20 cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-300",
							selectedDays === days
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground",
							isLocked && "cursor-not-allowed opacity-40 grayscale",
						)}
					>
						<p className="whitespace-nowrap">
							{t(`serverOnlineHistory.days${days}`)}
						</p>
					</div>
				);
			})}
		</div>
	);
}

function PeriodsModeSwitch({
	mode,
	onModeChange,
}: {
	mode: PeriodMode;
	onModeChange: (mode: PeriodMode) => void;
}) {
	const { t } = useTranslation();
	const options: PeriodMode[] = ["online", "offline"];
	const { containerRef, enableIndicatorAnimation, indicator, setItemRef } =
		useActiveIndicator(options, mode);

	return (
		<div
			ref={containerRef}
			className="relative flex gap-0.5 p-0.5 bg-muted dark:bg-muted/40 rounded-full w-fit border border-border/60 dark:border-border"
		>
			{indicator && (
				<div
					className="active-indicator-fade-in absolute left-0 top-0 z-10 bg-white dark:bg-background rounded-full ring-1 ring-border/60 dark:ring-border/40"
					style={{
						height: indicator.height,
						transform: `translate(${indicator.x}px, ${indicator.y}px)`,
						transition: indicator.shouldAnimate
							? "transform 0.5s var(--timing), width 0.5s var(--timing), height 0.5s var(--timing)"
							: "none",
						width: indicator.width,
					}}
				/>
			)}
			{options.map((option, index) => (
				<div
					key={option}
					ref={setItemRef(index)}
					onClick={() => {
						if (mode !== option) {
							enableIndicatorAnimation();
							onModeChange(option);
						}
					}}
					className={cn(
						"relative z-20 cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-300",
						mode === option
							? "text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<p className="whitespace-nowrap">
						{t(
							option === "online"
								? "serverOnlineHistory.periodsOnline"
								: "serverOnlineHistory.periodsOffline",
						)}
					</p>
				</div>
			))}
		</div>
	);
}

export default function ServerDetailOnlineHistory({
	server_id,
}: {
	server_id: string;
}) {
	const { t } = useTranslation();
	const [days, setDays] = useState(DAY_OPTIONS[1]);
	const [guestMaxDays, setGuestMaxDays] = useState<number | null>(null);
	const [periodMode, setPeriodMode] = useState<PeriodMode>("online");
	const [visibleDays, setVisibleDays] = useState(PERIODS_INITIAL_DAYS);

	const {
		data: historyData,
		isError,
		isPending,
		error: queryError,
	} = useQuery({
		queryKey: ["online-history", server_id, days],
		queryFn: () => fetchServerOnlineHistory(Number(server_id), days),
		placeholderData: keepPreviousData,
		refetchOnMount: true,
		refetchOnWindowFocus: true,
		refetchInterval: 60000,
	});

	// 游客仅能查 1 天：服务端拒绝 days>1 时自动回退到 1d 并锁定更长窗口，
	// 避免游客首屏只看到登录提示
	useEffect(() => {
		if (
			guestMaxDays === null &&
			queryError instanceof Error &&
			queryError.message.includes("only 1d data available for guests")
		) {
			setGuestMaxDays(1);
			setDays(1);
		}
	}, [guestMaxDays, queryError]);

	const customBackgroundImage =
		(window.CustomBackgroundImage as string) !== ""
			? window.CustomBackgroundImage
			: undefined;

	const online = historyData?.data;
	const tz = online?.timezone;

	if (isPending) {
		return <NetworkChartLoading />;
	}

	return (
		<div className="flex flex-col gap-4">
			<Card className={cn({ "bg-card/70": customBackgroundImage })}>
				<CardContent className="px-6 py-3">
					<DaysSelector
						selectedDays={days}
						maxDays={guestMaxDays ?? online?.max_days ?? DAY_OPTIONS[2]}
						onDaysChange={setDays}
					/>
					{isError && !online ? (
						<p className="text-xs text-muted-foreground">
							{t("serverOnlineHistory.loginRequired")}
						</p>
					) : (
						online && (
							<>
								<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
									<span className="flex items-center gap-1.5">
										<span
											className={cn(
												"size-2 rounded-full",
												online.currently_online
													? "bg-green-500"
													: "bg-gray-400",
											)}
										/>
										{online.currently_online ? t("online") : t("offline")}
									</span>
									<span className="text-muted-foreground">
										{t("serverOnlineHistory.onlineRate")}
										{": "}
										<span className="text-foreground">
											{online.online_rate.toFixed(1)}%
										</span>
									</span>
									<span className="text-muted-foreground">
										{t("serverOnlineHistory.totalOnline")}
										{": "}
										<span className="text-foreground">
											{formatDuration(online.total_online_seconds)}
										</span>
									</span>
									<span className="text-muted-foreground">
										{t("serverOnlineHistory.lastActive")}
										{": "}
										<span className="text-foreground">
											{online.last_active
												? panelDay(online.last_active, tz).format(
														"YYYY-MM-DD HH:mm:ss",
													)
												: "N/A"}
										</span>
									</span>
								</div>
								<Progress
									value={online.online_rate}
									indicatorClassName="bg-green-500"
									className="h-[3px] rounded-sm mt-2.5"
								/>
							</>
						)
					)}
				</CardContent>
			</Card>

			<Card className={cn({ "bg-card/70": customBackgroundImage })}>
				<CardContent className="px-6 py-3">
					<p className="text-xs font-medium text-muted-foreground">
						{t("serverOnlineHistory.dailyOnline")}
					</p>
					{/* 0:00–24:00 共享时间轴刻度 */}
					<div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/70">
						<span className="w-24 shrink-0" aria-hidden />
						<div className="relative h-3 flex-1">
							<span className="absolute left-0 top-0">0:00</span>
							<span className="absolute left-1/2 -translate-x-1/2 top-0">
								12:00
							</span>
							<span className="absolute right-0 top-0">24:00</span>
						</div>
						<span className="w-20 shrink-0" aria-hidden />
					</div>
					<TooltipProvider delayDuration={100}>
						<div className="flex flex-col gap-1.5 mt-1">
							{online?.daily.map((day) => {
								const segments = buildDaySegments(
									online?.periods ?? [],
									day.date,
									tz,
								);
								return (
									<div key={day.date} className="flex items-center gap-3">
										<span className="w-24 shrink-0 text-xs text-muted-foreground">
											{day.date}
										</span>
										<div className="relative h-2 flex-1 rounded-sm bg-muted dark:bg-muted/40 overflow-hidden">
											{segments.map((segment) => (
												<Tooltip
													key={`${segment.leftPct}-${segment.period.start}`}
												>
													<TooltipTrigger asChild>
														<div
															data-testid="online-segment"
															className={cn(
																"absolute inset-y-0 cursor-pointer rounded-sm bg-green-500 transition-colors hover:bg-green-400",
																segment.period.ongoing &&
																	segment.segEnd.isSame(
																		dayjs(segment.period.end),
																	) &&
																	"bg-green-400 dark:bg-green-500",
															)}
															style={{
																left: `${segment.leftPct}%`,
																width: `${segment.widthPct}%`,
																minWidth: 2,
															}}
														/>
													</TooltipTrigger>
													<TooltipContent className="px-2 py-1">
														<div className="flex flex-col gap-0.5">
															<span>
																{segment.segStart.format("HH:mm:ss")}
																{" → "}
																{segment.period.ongoing
																	? t("serverOnlineHistory.ongoing")
																	: segment.segEnd.format("HH:mm:ss")}
															</span>
															<span className="text-muted-foreground">
																{formatDuration(
																	segment.segEnd.diff(
																		segment.segStart,
																		"second",
																	),
																)}
															</span>
														</div>
													</TooltipContent>
												</Tooltip>
											))}
										</div>
										<span className="w-20 shrink-0 text-right text-xs">
											{formatDuration(day.online_seconds)}
										</span>
									</div>
								);
							})}
						</div>
					</TooltipProvider>
				</CardContent>
			</Card>

			<Card className={cn({ "bg-card/70": customBackgroundImage })}>
				<CardContent className="px-6 py-3">
					<div className="flex items-center justify-between gap-3 flex-wrap">
						<p className="text-xs font-medium text-muted-foreground">
							{t(
								periodMode === "online"
									? "serverOnlineHistory.periods"
									: "serverOnlineHistory.offlinePeriods",
							)}
						</p>
						<PeriodsModeSwitch
							mode={periodMode}
							onModeChange={(nextMode) => {
								setPeriodMode(nextMode);
								setVisibleDays(PERIODS_INITIAL_DAYS);
							}}
						/>
					</div>
					{(() => {
						if (!online) {
							return null;
						}
						const groups =
							periodMode === "online"
								? groupOnlinePeriods(online.periods, online.daily, tz)
								: buildOfflineGroups(
										online.periods,
										online.daily,
										online.window_end,
										online.currently_online,
										tz,
									);
						const visibleGroups = groups.slice(0, visibleDays);
						if (groups.length === 0) {
							return (
								<p className="text-xs text-muted-foreground mt-2.5">
									{t("serverOnlineHistory.noData")}
								</p>
							);
						}
						return (
							<TooltipProvider delayDuration={100}>
								<div className="flex flex-col gap-4 mt-3">
									{visibleGroups.map((group) => (
										<div key={group.date} data-testid="period-day">
											<div className="flex items-baseline justify-between gap-3 pb-1.5">
												<span className="text-xs font-medium">
													{group.day.format("MM-DD")}
													{group.day.isSame(panelNow(tz), "day") && (
														<span className="text-muted-foreground font-normal">
															{" · "}
															{t("serverOnlineHistory.today")}
														</span>
													)}
												</span>
												<span className="text-xs text-muted-foreground">
													{t(periodMode === "online" ? "online" : "offline")}{" "}
													<span>{formatDuration(group.total)}</span>
												</span>
											</div>
											<div className="flex flex-wrap gap-1.5">
												{group.chips.map((chip, index) => {
													const seconds = chip.end.diff(chip.start, "second");
													return (
														<Tooltip key={`${chip.start.valueOf()}-${index}`}>
															<TooltipTrigger asChild>
																<span
																	data-testid="period-chip"
																	className={cn(
																		"inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs tabular-nums transition-colors cursor-pointer",
																		chip.ongoing
																			? "border-green-500/30 bg-green-500/15 text-green-500"
																			: "border-border/60 dark:border-border bg-muted/50 dark:bg-muted/30 text-foreground hover:bg-muted dark:hover:bg-muted/50",
																	)}
																>
																	{chip.ongoing && (
																		<span className="size-1.5 rounded-full bg-green-500 animate-pulse" />
																	)}
																	{chip.start.format("HH:mm")}
																	{" → "}
																	{chip.ongoing
																		? t("serverOnlineHistory.ongoing")
																		: chip.end.format("HH:mm")}
																	<span className="text-muted-foreground">
																		{formatDuration(seconds)}
																	</span>
																</span>
															</TooltipTrigger>
															<TooltipContent className="px-2 py-1">
																{chip.start.format("HH:mm:ss")}
																{" → "}
																{chip.ongoing
																	? t("serverOnlineHistory.ongoing")
																	: chip.end.format("HH:mm:ss")}
																{" · "}
																{formatDuration(seconds)}
															</TooltipContent>
														</Tooltip>
													);
												})}
											</div>
										</div>
									))}
									{groups.length > visibleDays && (
										<button
											type="button"
											onClick={() =>
												setVisibleDays((d) => d + PERIODS_EXPAND_STEP)
											}
											className="w-full border border-dashed border-border rounded-md py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
										>
											{t("serverOnlineHistory.expandMore")}
										</button>
									)}
								</div>
							</TooltipProvider>
						);
					})()}
				</CardContent>
			</Card>
		</div>
	);
}
