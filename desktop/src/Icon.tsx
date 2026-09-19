import type { CSSProperties } from "react";
export type IconName =
  | "grid"
  | "disk"
  | "activity"
  | "shield"
  | "folder"
  | "arrow"
  | "chevron"
  | "cpu"
  | "memory"
  | "network"
  | "refresh"
  | "search"
  | "file"
  | "back"
  | "check"
  | "stop"
  | "info"
  | "external"
  | "lock"
  | "spark"
  | "download"
  | "upload";
const paths: Record<IconName, string[]> = {
  grid: ["M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"],
  disk: ["M5 3h14l3 13v5H2v-5L5 3Z M2 16h20 M6 19h.01 M10 19h.01"],
  activity: ["M2 12h4l3-8 6 16 3-8h4"],
  shield: ["M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z", "m8 12 3 3 5-6"],
  folder: ["M3 7V4h7l2 3h9v13H3V7Z"],
  arrow: ["M4 12h16 m-6-6 6 6-6 6"],
  chevron: ["m9 5 7 7-7 7"],
  cpu: [
    "M7 7h10v10H7z M10 10h4v4h-4z M9 2v5 M15 2v5 M9 17v5 M15 17v5 M2 9h5 M2 15h5 M17 9h5 M17 15h5",
  ],
  memory: ["M3 6h18v12H3z M7 10v4 M11 10v4 M15 10v4 M7 18v3 M12 18v3 M17 18v3"],
  network: [
    "M3 9a15 15 0 0 1 18 0 M6 12a10 10 0 0 1 12 0 M9 15a5 5 0 0 1 6 0 M12 19h.01",
  ],
  refresh: [
    "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 3 M18 17a7 7 0 0 1-12 2l-2-3",
  ],
  search: ["M20 20l-5-5", "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"],
  file: ["M5 3h9l5 5v13H5Z M14 3v6h5 M8 14h8 M8 17h6"],
  back: ["M20 12H4 m6-6-6 6 6 6"],
  check: ["m5 12 4 4 10-10"],
  stop: ["M6 6h12v12H6z"],
  info: ["M12 10v7 M12 7h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"],
  external: ["M14 3h7v7 M21 3 11 13 M10 3H3v18h18v-7"],
  lock: ["M6 10h12v11H6Z M8 10V6a4 4 0 0 1 8 0v4"],
  spark: ["m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"],
  download: ["M12 3v13 m-5-5 5 5 5-5 M4 17v4h16v-4"],
  upload: ["M12 17V4 m-5 5 5-5 5 5 M4 17v4h16v-4"],
};
export function Icon({
  name,
  size = 20,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {paths[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
