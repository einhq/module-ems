# The media service's card, every 15 s, into the `gpu` metrics series: utilization, VRAM and
# temperature as EMS's own nvidia-smi sees them (ems-gpu-sample). `ems-gpu` reads it back for the
# system dashboard's GPU panel, ems's `system.overview` panel.
#
# The log is created on the first reading rather than at start, so a deployment with no card, or
# no media service, never gets an empty series that would read as an idle GPU. A tick with no
# reading writes nothing.
log="$LOGS_PATH/metrics/gpu"
echo "gpu-sampler: sampling into $log every 15s"

while true; do
  sample=$(JSON_OUTPUT=1 ems-gpu-sample 2>/dev/null)
  if [ -n "$sample" ] && [ "$sample" != "null" ]; then
    if [ ! -e "$log" ]; then
      mkdir -p "$LOGS_PATH/metrics"
      mklog -r '7 day' "$log"
    fi
    echo "$sample" >> "$log"
  fi
  sleep 15
done
