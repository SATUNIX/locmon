# Metrics and dashboard controls


- CPU: deltas of `/proc/stat`, per logical core, load averages, and the mean sampled clock frequency across logical cores. Guest time is not double counted; iowait is treated as idle.
- RAM: total minus `MemAvailable`; reclaimable cache is available memory. Swap shown separately.
- GPU: device busy percentage when exposed; otherwise the busiest engine computed from DRM client counter deltas. Xe cycle counters are normalized to total GPU cycles and engine capacity. Client fds are deduplicated by PCI device and DRM client ID. Only processes readable by the service user are included; this is explicitly labeled in the dashboard. New clients are discovered on the first sampling tick after ten seconds have elapsed. Unsupported counters show a dash.
- VRAM: device-wide Xe memory-region allocation estimate via read-only DRM ioctl, or AMD sysfs memory counters. Refreshed on the first sampling tick after six seconds have elapsed, with sample age displayed. No root or elevated profiling access is needed. NVIDIA-specific metrics are not implemented.
- Temperatures and fans: hwmon sensor labels, values, and driver-provided limits. Board auxiliary channels may be unconnected; all raw channels remain available in the disclosure. CPU and GPU package sensors are highlighted separately.
- Disks: filesystem capacity is refreshed on the first sampling tick after thirty seconds have elapsed; sample age is shown. Btrfs shared subvolume capacity is shown once. Percentage is used / total capacity, displayed to one decimal rather than rounded up to a whole percent. Available bytes exclude filesystem reservations. Physical disk throughput and busy time come from `/proc/diskstats`. Low space is flagged at 85%, with a notice at 90%.
- Network: physical/VPN interface counters from `/proc/net/dev`; loopback, bridges, containers, and veths are excluded. Rates are per second, byte totals are since boot.

One collector serves all tabs through server-sent events. History is a bounded in-memory buffer of thirty minutes, with at most 1,801 samples, shared across tabs and cleared at service restart. Hidden browser tabs keep receiving data and skip rendering; pause freezes the displayed data and charts while collection continues. Disconnections are labeled and reconnect automatically.

## Dashboard controls

- **Edit dashboard:** drag card headers or use their arrow buttons to reorder. Choose quarter/half/full widths, hide/show panels, and reset the layout. Every card can collapse independently. Layout, theme, card-average window and chart window are saved in this browser.
- **Card average:** current reading or a time-weighted mean over 10/30/60/120/300 seconds. Interval-end samples are weighted by actual elapsed time, so changing sample intervals does not bias the mean. Unknown values and collection outages are excluded. Startup coverage is labeled. The overview and inference callouts use the selected average; per-core readings, engines, temperatures, network, and chart lines remain unsmoothed. Current CPU/GPU readings remain beside averages.
- **Chart window:** slider selects 1–30 minutes for all line charts. Only observed data is drawn; no synthetic history is inserted. Inference charts scale to visible data; utilization charts stay at 0–100%.
- **Sampling:** change the shared collector interval from 1–30 seconds. The browser offers 1/2/5/10/30 seconds. Changes apply to every viewer and persist in `~/.config/locmon/settings.json`. Disk/VRAM metadata retain their slower refresh cadences. Rates use actual elapsed time; changing the interval does not reset counters or history.
