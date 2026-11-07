# The media service's card, every 15 s, into the `gpu` metrics series: utilization, VRAM and
# temperature as EMS's own nvidia-smi sees them (ems-gpu-sample). `ems-gpu` reads it back for the
# system dashboard's GPU panel, ems's `system.overview` panel.
#
# And each minute, what the media service holds, into the `ems-models` series: the card mode, every
# model copy and where it is, and the models working (ems-models-sample). `ems-models` reads it
# back for the Media service tab's strip.
#
# A log is created on its first reading rather than at start, so a deployment with no card, or
# no media service, never gets an empty series that would read as an idle GPU. A tick with no
# reading writes nothing.
gpu_log="$LOGS_PATH/metrics/gpu"
models_log="$LOGS_PATH/metrics/ems-models"
echo "gpu-sampler: sampling into $gpu_log every 15s and $models_log every minute"

append() {
  if [ ! -e "$1" ]; then
    mkdir -p "$LOGS_PATH/metrics"
    mklog -r "$2" "$1"
  fi
  echo "$3" >> "$1"
}

tick=0
while true; do
  sample=$(JSON_OUTPUT=1 ems-gpu-sample 2>/dev/null)
  if [ -n "$sample" ] && [ "$sample" != "null" ]; then
    append "$gpu_log" '7 day' "$sample"
  fi
  if [ $((tick % 4)) -eq 0 ]; then
    models=$(JSON_OUTPUT=1 ems-models-sample 2>/dev/null)
    if [ -n "$models" ] && [ "$models" != "null" ]; then
      append "$models_log" '7 day' "$models"
    fi
  fi
  tick=$((tick + 1))
  sleep 15
done
