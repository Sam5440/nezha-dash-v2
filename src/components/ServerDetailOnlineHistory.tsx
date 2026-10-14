import { keepPreviousData, useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import NetworkChartLoading from "@/components/NetworkChartLoading";
import { Badge } from "@/components/ui/badge";
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
import type { OnlinePeriod } from "@/types/nezha-api";

const DAY_OPTIONS = [1, 7, 30];

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
function buildDaySegments(periods: OnlinePeriod[], date: string) {
	const dayStart = dayjs(date).startOf("day");
	const dayEnd = dayStart.add(1, "day");
	return periods
		.map((period) => {
			const start = dayjs(period.start);
			const end = dayjs(period.end);
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
			{DAY_OPTIONS.map((days) => {
				const isLocked = days > maxDays;
				return (
					<div
						key={days}
						ref={setItemRef(days)}
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

export default function ServerDetailOnlineHistory({
	server_id,
}: {
	server_id: string;
}) {
	const { t } = useTranslation();
	const [days, setDays] = useState(DAY_OPTIONS[1]);

	const {
		data: historyData,
		isError,
		isPending,
	} = useQuery({
		queryKey: ["online-history", server_id, days],
		queryFn: () => fetchServerOnlineHistory(Number(server_id), days),
		placeholderData: keepPreviousData,
		refetchOnMount: true,
		refetchOnWindowFocus: true,
		refetchInterval: 60000,
	});

	const customBackgroundImage =
		(window.CustomBackgroundImage as string) !== ""
			? window.CustomBackgroundImage
			: undefined;

	const online = historyData?.data;

	if (isPending) {
		return <NetworkChartLoading />;
	}

	return (
		<div className="flex flex-col gap-4">
			<Card className={cn({ "bg-card/70": customBackgroundImage })}>
				<CardContent className="px-6 py-3">
					<DaysSelector
						selectedDays={days}
						maxDays={online?.max_days ?? DAY_OPTIONS[2]}
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
												? dayjs(online.last_active).format(
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
					<p className="text-xs font-medium text-muted-foreground">
						{t("serverOnlineHistory.periods")}
					</p>
					<div className="flex flex-col gap-1.5 mt-2.5">
						{online?.periods.length === 0 && (
							<p className="text-xs text-muted-foreground">
								{t("serverOnlineHistory.noData")}
							</p>
						)}
						{online?.periods
							.slice()
							.reverse()
							.map((period, index: number) => (
								<div
									key={index}
									className="flex items-center justify-between gap-3 text-xs"
								>
									<span>
										{dayjs(period.start).format("MM-DD HH:mm:ss")}
										{" → "}
										{period.ongoing
											? t("serverOnlineHistory.ongoing")
											: dayjs(period.end).format("MM-DD HH:mm:ss")}
									</span>
									{period.ongoing ? (
										<Badge className="bg-green-500/15 text-green-500 border-green-500/30">
											{t("serverOnlineHistory.ongoing")}
										</Badge>
									) : (
										<span className="text-muted-foreground">
											{formatDuration(
												dayjs(period.end).diff(dayjs(period.start), "second"),
											)}
										</span>
									)}
								</div>
							))}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
