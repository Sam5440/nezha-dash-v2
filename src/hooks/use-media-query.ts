import { useEffect, useState } from "react";

// matchMedia 不可用（如 jsdom）时默认命中桌面布局，保证测试环境渲染完整概要
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (
			typeof window === "undefined" ||
			typeof window.matchMedia !== "function"
		) {
			return true;
		}
		return window.matchMedia(query).matches;
	});

	useEffect(() => {
		if (typeof window.matchMedia !== "function") {
			return;
		}
		const mediaQueryList = window.matchMedia(query);
		const onChange = (event: MediaQueryListEvent) => {
			setMatches(event.matches);
		};
		setMatches(mediaQueryList.matches);
		mediaQueryList.addEventListener("change", onChange);
		return () => {
			mediaQueryList.removeEventListener("change", onChange);
		};
	}, [query]);

	return matches;
}
