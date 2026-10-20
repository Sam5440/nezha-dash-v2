import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import type { DailyOnlineStat, OnlinePeriod } from "@/types/nezha-api";

dayjs.extend(utc);
dayjs.extend(timezone);

export type PeriodChip = {
	start: dayjs.Dayjs;
	end: dayjs.Dayjs;
	ongoing: boolean;
};

export type PeriodDayGroup = {
	date: string;
	day: dayjs.Dayjs;
	total: number;
	chips: PeriodChip[];
};

export type DaySegment = {
	period: OnlinePeriod;
	segStart: dayjs.Dayjs;
	segEnd: dayjs.Dayjs;
	leftPct: number;
	widthPct: number;
	/** 该段是否仍然进行中（只有结束于真实会话末尾的段才为 true） */
	live: boolean;
};

// 后端按面板时区拆日；响应带 timezone 时前端用同一时区解释时间，
// 保证跨时区访客的时间轴、分组与每日数字一致
export function panelDay(value: string, tz?: string): dayjs.Dayjs {
	// dayjs 的 .tz(input, zone) 解析模式会忽略输入里的显式偏移（Z / ±HH:MM）：
	// 带偏移的时间戳须先按原义解析再换算时区，无偏移的日期串才用 zone 解析
	if (tz) {
		return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
			? dayjs(value).tz(tz)
			: dayjs.tz(value, tz);
	}
	return dayjs(value);
}

export function panelNow(tz?: string): dayjs.Dayjs {
	return tz ? dayjs().tz(tz) : dayjs();
}

// 下一天的日历日期用 UTC 做纯日期运算，避免 dayjs .add(1, "day")
// 在 DST 切换日加的是 24 小时而不是下一个挂钟零点
function nextDate(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + 1))
		.toISOString()
		.slice(0, 10);
}

export function panelNextDayStart(date: string, tz?: string): dayjs.Dayjs {
	return panelDay(nextDate(date), tz);
}

// 结束于次日零点的段在 chip 上显示为 24:00，避免出现“00:00 → 00:00”这种读不通的全天段
export function formatPeriodMoment(
	value: dayjs.Dayjs,
	anchor: dayjs.Dayjs,
	tz?: string,
	withSeconds = false,
): string {
	const dayEnd = panelNextDayStart(anchor.format("YYYY-MM-DD"), tz);
	if (value.isSame(dayEnd)) {
		return withSeconds ? "24:00:00" : "24:00";
	}
	return value.format(withSeconds ? "HH:mm:ss" : "HH:mm");
}

export function formatDuration(seconds: number): string {
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

// 时间轴刻度是固定的挂钟 0:00–24:00，定位必须用面板时区的挂钟时间；
// 用 elapsed seconds / 86400 会在 DST 切换日（23h/25h）偏移
function wallClockPercent(value: dayjs.Dayjs): number {
	const seconds =
		value.hour() * 3600 +
		value.minute() * 60 +
		value.second() +
		value.millisecond() / 1000;
	return (seconds / 86400) * 100;
}

// 把一天映射到 0:00–24:00 整轴：裁剪出该日与每个时间段的交集，
// 换算成轨道内的挂钟百分比坐标。
export function buildDaySegments(
	periods: OnlinePeriod[],
	date: string,
	tz?: string,
): DaySegment[] {
	const dayStart = panelDay(date, tz);
	const dayEnd = panelNextDayStart(date, tz);
	return periods
		.map((period) => {
			const start = panelDay(period.start, tz);
			const end = panelDay(period.end, tz);
			if (!end.isAfter(dayStart) || !start.isBefore(dayEnd)) {
				return null;
			}
			const segStart = start.isAfter(dayStart) ? start : dayStart;
			const segEnd = end.isBefore(dayEnd) ? end : dayEnd;
			const leftPct = segStart.isSame(dayStart)
				? 0
				: wallClockPercent(segStart);
			const rightPct = segEnd.isSame(dayEnd) ? 100 : wallClockPercent(segEnd);
			const widthPct = Math.max(0, Math.min(rightPct - leftPct, 100 - leftPct));
			if (widthPct <= 0) {
				return null;
			}
			return {
				period,
				segStart,
				segEnd,
				leftPct,
				widthPct,
				// 跨天裁剪出的历史段结束于日界，不应显示为 Ongoing
				live: period.ongoing && segEnd.isSame(end),
			};
		})
		.filter((segment): segment is DaySegment => segment !== null);
}

// 合并重叠/相邻的时间段，按开始时间排序
export function mergePeriods(
	periods: OnlinePeriod[],
	tz?: string,
): PeriodChip[] {
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

// 在线模式：按开始日分组（跨天时段归入开始日），合计取组内可见 chip 的时长之和，
// 避免组头数字与 chip 上的时长互相矛盾
export function groupOnlinePeriods(
	periods: OnlinePeriod[],
	tz?: string,
): PeriodDayGroup[] {
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
			total: chips.reduce(
				(sum, chip) => sum + chip.end.diff(chip.start, "second"),
				0,
			),
			chips,
		}));
}

// 离线模式：对窗口内每一天求在线时段的补集。计算区间先与查询窗口取交集，
// 避免在窗口开始前/结束后凭空生成离线段；服务器当前离线时，结束于窗口末端的
// 最新一段标记为进行中。
export function buildOfflineGroups(
	periods: OnlinePeriod[],
	daily: DailyOnlineStat[],
	windowStart: string,
	windowEnd: string,
	currentlyOnline: boolean,
	tz?: string,
): PeriodDayGroup[] {
	const merged = mergePeriods(periods, tz);
	const secondsByDate = new Map(
		daily.map((day) => [day.date, day.online_seconds]),
	);
	const windowStartTime = panelDay(windowStart, tz);
	const windowEndTime = panelDay(windowEnd, tz);
	const groups = daily
		.map((day) => day.date)
		.sort((a, b) => (a < b ? 1 : -1))
		.flatMap((date): PeriodDayGroup[] => {
			const dayStart = panelDay(date, tz);
			const dayEnd = panelNextDayStart(date, tz);
			// 当天与查询窗口的交集；首日/末日通常不是完整 24 小时
			const effectiveStart = dayStart.isAfter(windowStartTime)
				? dayStart
				: windowStartTime;
			const effectiveEnd = dayEnd.isBefore(windowEndTime)
				? dayEnd
				: windowEndTime;
			if (!effectiveEnd.isAfter(effectiveStart)) {
				return [];
			}
			const chips: PeriodChip[] = [];
			let cursor = effectiveStart;
			for (const segment of merged) {
				if (!segment.end.isAfter(effectiveStart)) {
					continue;
				}
				// merged 按开始时间升序；到达当天区间之后的时段即可停止，
				// 否则会把未来日期的开始时刻当成当天的 gap 终点
				if (!segment.start.isBefore(effectiveEnd)) {
					break;
				}
				const segStart = segment.start.isAfter(cursor) ? segment.start : cursor;
				if (segStart.isAfter(cursor)) {
					chips.push({ start: cursor, end: segStart, ongoing: false });
				}
				const segEnd = segment.end.isBefore(effectiveEnd)
					? segment.end
					: effectiveEnd;
				if (segEnd.isAfter(cursor)) {
					cursor = segEnd;
				}
			}
			if (cursor.isBefore(effectiveEnd)) {
				chips.push({ start: cursor, end: effectiveEnd, ongoing: false });
			}
			const windowSeconds = effectiveEnd.diff(effectiveStart, "second");
			const total = Math.max(
				0,
				windowSeconds -
					(secondsByDate.get(date) ??
						chips.reduce(
							(sum, chip) => sum + chip.end.diff(chip.start, "second"),
							0,
						)),
			);
			return [{ date, day: dayStart, total, chips }];
		})
		.filter((group) => group.chips.length > 0);
	if (!currentlyOnline && groups.length > 0) {
		const newest = groups[0].chips;
		const last = newest[newest.length - 1];
		// 只有真正持续到窗口末端的离线段才是进行中；旧日期的段不能误标
		if (last?.end.isSame(windowEndTime)) {
			last.ongoing = true;
		}
	}
	return groups;
}
