# Each instance of the media service's card, every 15 s, into its `gpu` metrics series:
# utilization, VRAM and temperature as EMS's own nvidia-smi sees them (ems-gpu-sample). `ems-gpu`
# reads it back for the system dashboard's GPU panel, ems's `system.overview` panel.
#
# And each minute, what each instance holds, into its `ems-models` series: the card mode, every
# model copy and where it is, and the models working (ems-models-sample). `ems-models` reads it
# back for the Media service tab's strip.
#
# The primary's series are `gpu` and `ems-models`, another instance's `gpu-<name>` and
# `ems-models-<name>`. A log is created on its first reading rather than at start, so an instance
# with no card, or no media service, never gets an empty series that would read as an idle GPU. A
# tick with no reading writes nothing.
echo "gpu-sampler: sampling into $LOGS_PATH/metrics every 15s and each minute"

append() {
  if [ ! -e "$1" ]; then
    mkdir -p "$LOGS_PATH/metrics"
    mklog -r "$2" "$1"
  fi
  echo "$3" >> "$1"
}

tick=0
while true; do
  for name in $(ems-instance list --names 2>/dev/null); do
    suffix=""
    if [ "$name" != main ]; then
      suffix="-$name"
    fi
    sample=$(JSON_OUTPUT=1 ems-gpu-sample --instance "$name" 2>/dev/null)
    if [ -n "$sample" ] && [ "$sample" != "null" ]; then
      append "$LOGS_PATH/metrics/gpu$suffix" '7 day' "$sample"
    fi
    if [ $((tick % 4)) -eq 0 ]; then
      models=$(JSON_OUTPUT=1 ems-models-sample --instance "$name" 2>/dev/null)
      if [ -n "$models" ] && [ "$models" != "null" ]; then
        append "$LOGS_PATH/metrics/ems-models$suffix" '7 day' "$models"
      fi
    fi
  done
  tick=$((tick + 1))
  sleep 15
done
