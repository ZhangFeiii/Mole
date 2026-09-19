# Third-party notices

Mole Desktop is an independent community GUI in ZhangFeiii/Mole, forked from
tw93/Mole's MIT-licensed `windows` branch at
`4b9bb74036bea901e56cf23508455bf3087479b1`.

The original copyright (c) 2025 tw93 and complete MIT terms are retained in the
repository LICENSE and packaged as `resources/agent/licenses/Mole-MIT.txt`.
The Go metrics collection approach is adapted from `cmd/status/main.go`.
The desktop scanner is a new, complete/bounded metadata scan; it does not call
the original TUI's shallow estimator or any PowerShell cleanup command.

The application uses React, React DOM and Scheduler (MIT), Go (BSD), and the
upstream gopsutil dependency tree. The build copies the complete license texts
of every Go module linked into the target collector, the Go runtime, and the
React packages to `resources/agent/licenses/`. Electron's distribution supplies
its own Electron and Chromium license notices alongside the executable.

The interface icons, CSS planet illustration and layout are newly authored for
this fork. No code, artwork, activation keys, or injected libraries have been
copied from the proprietary Mole macOS application. This is not an official
Mole GUI release and is not affiliated with or endorsed by its author.
