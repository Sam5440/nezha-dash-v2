import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import NetworkChartLoading from "@/components/NetworkChartLoading";
import { Card, CardContent } from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActiveIndicator } from "@/hooks/use-active-indicator";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fetchServerOnlineHistory } from "@/lib/nezha-api";
import {
	buildDaySegments,
	buildOfflineGroups,
	formatDuration,
	formatPeriodMoment,
	groupOnlinePeriods,
	panelDay,
	panelNow,
} from "@/lib/online-history";
import { cn } from "@/lib/utils";
import type { DailyOnlineStat } from "@/types/nezha-api";

const DAY_OPTIONS = [1, 7, 30];
// Online periods 默认只展开最近 1 天，每次「展开更多」追加 10 天
const PERIODS_INITIAL_DAYS = 1;
const PERIODS_EXPAND_STEP = 10;

type PeriodMode = "online" | "offline";

// 概要卡的小方块标签；accent 用于在线率等需要突出的指标
function SummaryLabel({
	children,
	accent = false,
}: {
	children: ReactNode;
	accent?: boolean;
}) {
	return (
		<span
			className={cn(
				"self-start rounded-lg px-2 py-0.5 text-[11px] leading-4",
				accent
					? "bg-green-500/15 text-green-600 dark:text-green-500"
					: "bg-muted text-muted-foreground dark:bg-muted/40",
			)}
		>
			{children}
		</span>
	);
}

// 概要卡的信息盒：标签在上、数值在下
function SummaryBox({
	label,
	accent = false,
	children,
}: {
	label: ReactNode;
	accent?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col items-start gap-1.5 rounded-xl bg-muted/50 px-3 py-2.5 dark:bg-muted/30">
			<SummaryLabel accent={accent}>{label}</SummaryLabel>
			{children}
		</div>
	);
}

// 近 N 天每日在线率趋势：按 86400s 归一的迷你面积图，末点空心标记最新一天
function RateSparkline({
	daily,
	className,
	showRange = true,
}: {
	daily: DailyOnlineStat[];
	className?: string;
	showRange?: boolean;
}) {
	if (daily.length < 2) {
		return null;
	}
	const width = 200;
	const height = 48;
	const pad = 4;
	const rates = daily.map((day) =>
		Math.max(0, Math.min(100, (day.online_seconds / 86400) * 100)),
	);
	const step = (width - pad * 2) / (rates.length - 1);
	const pointY = (rate: number) => pad + (1 - rate / 100) * (height - pad * 2);
	const points = rates
		.map((rate, index) => `${pad + index * step},${pointY(rate).toFixed(1)}`)
		.join(" ");
	const lastY = pointY(rates[rates.length - 1]);
	return (
		<div className={cn("relative", className)}>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="block h-12 w-full"
				aria-hidden
			>
				<defs>
					<linearGradient
						id="online-rate-spark-fill"
						x1="0"
						y1="0"
						x2="0"
						y2="1"
					>
						<stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
						<stop offset="100%" stopColor="currentColor" stopOpacity="0" />
					</linearGradient>
				</defs>
				<polygon
					points={`${pad},${height - pad} ${points} ${width - pad},${height - pad}`}
					fill="url(#online-rate-spark-fill)"
				/>
				<polyline
					points={points}
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinejoin="round"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<span
				className="absolute size-2 rounded-full border-2 border-green-500 bg-card"
				style={{ right: 2, top: lastY - 4 }}
			/>
			{showRange && (
				<span className="mt-1 block text-center text-[11px] leading-4 text-muted-foreground tabular-nums">
					{daily[0].date} – {daily[daily.length - 1].date}
				</span>
			)}
		</div>
	);
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
			data-testid="days-selector"
			className="relative flex gap-0.5 flex-wrap p-0.5 bg-muted dark:bg-muted/40 rounded-full w-fit border border-border/60 dark:border-border"
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
			data-testid="period-mode-switch"
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
	// 概要卡在 md 断点切换：桌面为三盒等宽 + 全宽趋势条（F3），窄屏为大数字 + 双盒（F1）
	const isDesktop = useMediaQuery("(min-width: 768px)");

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
					<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
						{online && (
							<span
								className={cn(
									"inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium",
									online.currently_online
										? "bg-green-500/10 text-green-600 dark:text-green-500"
										: "bg-muted text-muted-foreground",
								)}
							>
								<span
									className={cn(
										"size-2 rounded-full",
										online.currently_online ? "bg-green-500" : "bg-gray-400",
									)}
								/>
								{online.currently_online ? t("online") : t("offline")}
							</span>
						)}
						<DaysSelector
							selectedDays={days}
							maxDays={guestMaxDays ?? online?.max_days ?? DAY_OPTIONS[2]}
							onDaysChange={setDays}
						/>
					</div>
					{isError && !online ? (
						<p className="text-xs text-muted-foreground">
							{t("serverOnlineHistory.loginRequired")}
						</p>
					) : (
						online &&
						(isDesktop ? (
							<div
								className="flex flex-col gap-3"
								data-testid="summary-desktop"
							>
								<div className="grid grid-cols-3 gap-2.5">
									<SummaryBox
										label={t("serverOnlineHistory.onlineRate")}
										accent
									>
										<span className="text-lg font-medium tabular-nums text-foreground">
											{online.online_rate.toFixed(1)}%
										</span>
										<div className="h-1 w-full overflow-hidden rounded-full bg-muted dark:bg-muted/40">
											<div
												className="h-full rounded-full bg-green-500"
												style={{
													width: `${Math.min(100, Math.max(0, online.online_rate))}%`,
												}}
											/>
										</div>
									</SummaryBox>
									<SummaryBox label={t("serverOnlineHistory.totalOnline")}>
										<span className="text-lg font-medium tabular-nums text-foreground">
											{formatDuration(online.total_online_seconds)}
										</span>
									</SummaryBox>
									<SummaryBox label={t("serverOnlineHistory.lastActive")}>
										{online.last_active ? (
											<>
												<span className="text-lg font-medium tabular-nums text-foreground">
													{panelDay(online.last_active, tz).format("HH:mm:ss")}
												</span>
												<span className="text-[11px] leading-4 text-muted-foreground tabular-nums">
													{panelDay(online.last_active, tz).format(
														"YYYY-MM-DD",
													)}
												</span>
											</>
										) : (
											<span className="text-lg font-medium text-foreground">
												N/A
											</span>
										)}
									</SummaryBox>
								</div>
								<RateSparkline
									daily={online.daily}
									className="w-full text-green-500"
								/>
							</div>
						) : (
							<div className="flex flex-col gap-3" data-testid="summary-mobile">
								<div className="flex items-center justify-between gap-4">
									<div className="flex min-w-0 flex-col items-start gap-1.5">
										<SummaryLabel accent>
											{t("serverOnlineHistory.onlineRate")}
										</SummaryLabel>
										<span className="text-2xl font-medium tabular-nums text-foreground">
											{online.online_rate.toFixed(1)}%
										</span>
									</div>
									<RateSparkline
										daily={online.daily}
										showRange={false}
										className="w-36 shrink-0 text-green-500"
									/>
								</div>
								<div className="grid grid-cols-2 gap-2.5">
									<SummaryBox label={t("serverOnlineHistory.totalOnline")}>
										<span className="text-base font-medium tabular-nums text-foreground">
											{formatDuration(online.total_online_seconds)}
										</span>
									</SummaryBox>
									<SummaryBox label={t("serverOnlineHistory.lastActive")}>
										<span className="text-base font-medium tabular-nums text-foreground">
											{online.last_active
												? panelDay(online.last_active, tz).format("HH:mm:ss")
												: "N/A"}
										</span>
										{online.last_active && (
											<span className="text-[11px] leading-4 text-muted-foreground tabular-nums">
												{panelDay(online.last_active, tz).format("YYYY-MM-DD")}
											</span>
										)}
									</SummaryBox>
								</div>
							</div>
						))
					)}
				</CardContent>
			</Card>

			<Card className={cn({ "bg-card/70": customBackgroundImage })}>
				<CardContent className="px-6 py-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="text-xs font-medium text-muted-foreground">
							{t("serverOnlineHistory.dailyOnline")}
						</p>
						{/* 面板时区下的 0:00–24:00 挂钟轴 */}
						<span className="rounded-lg bg-muted px-2 py-0.5 text-[11px] leading-4 text-muted-foreground tabular-nums dark:bg-muted/40">
							0:00 – 24:00{tz ? ` · ${tz}` : ""}
						</span>
					</div>
					<TooltipProvider delayDuration={100}>
						{/* 宽屏两列一行两日；末行为奇数时占满整行 */}
						<div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-x-4 md:[&>*:last-child:nth-child(odd)]:col-span-2">
							{online?.daily.map((day) => {
								const segments = buildDaySegments(
									online?.periods ?? [],
									day.date,
									tz,
								);
								return (
									<div
										key={day.date}
										className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted/40 px-2.5 py-2 dark:bg-muted/20"
									>
										<div className="flex items-baseline justify-between gap-2 text-xs">
											<span className="text-foreground tabular-nums">
												{day.date}
											</span>
											<span className="text-muted-foreground tabular-nums">
												{formatDuration(day.online_seconds)}
											</span>
										</div>
										<div className="relative h-2 overflow-hidden rounded-sm bg-muted dark:bg-muted/40">
											<span
												className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px bg-foreground/10"
												aria-hidden
											/>
											{segments.map((segment) => (
												<Tooltip
													key={`${segment.leftPct}-${segment.period.start}`}
												>
													<TooltipTrigger asChild>
														<div
															data-testid="online-segment"
															className={cn(
																"absolute inset-y-0 cursor-pointer rounded-sm bg-green-500 transition-colors hover:bg-green-400",
																segment.live &&
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
																{segment.live
																	? t("serverOnlineHistory.ongoing")
																	: formatPeriodMoment(
																			segment.segEnd,
																			segment.segStart,
																			tz,
																			true,
																		)}
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
								? groupOnlinePeriods(online.periods, tz)
								: buildOfflineGroups(
										online.periods,
										online.daily,
										online.window_start,
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
																		"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs tabular-nums transition-colors cursor-pointer",
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
																		: formatPeriodMoment(
																				chip.end,
																				chip.start,
																				tz,
																			)}
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
																	: formatPeriodMoment(
																			chip.end,
																			chip.start,
																			tz,
																			true,
																		)}
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
											data-testid="periods-expand"
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
