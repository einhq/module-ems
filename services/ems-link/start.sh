# EMS is not an EiN service — it is a container of its own — but the dashboard reads service
# rows, and the crawl is blind without one for it: a backlog that stops draining looks exactly
# like a slow crawl until someone asks. This service is that row. Its statusCommand puts EMS's
# one-line health beside it, and the loop below logs every change of reachability, so "EMS went
# away at 03:12" is in a service log rather than reconstructed from failed steps.
#
# A new EMS build is the likeliest fix for whatever failed under the last one, so when the build
# changes, every failed pipeline instance gets one run at once (`pipeline heal --now`) instead of
# waiting out its heal. Not on the first build seen: a restart of EiN is not a new EMS.
echo ems-link: watching "${CFG_EMS_URL:-http://127.0.0.1:8181}"

last=""
build=""
while true; do
  if state=$(JSON_OUTPUT=0 ems-status --brief 2>/dev/null); then
    reachable=up
    now=$(JSON_OUTPUT=1 ems-status 2>/dev/null | jq -r .build.commit)
    if [ -n "$now" ] && [ "$now" != "null" ]; then
      if [ -n "$build" ] && [ "$now" != "$build" ]; then
        echo "ems-link: EMS $build -> $now; failed work runs again: $(pipeline heal --now --apply)"
      fi
      build=$now
    fi
  else
    reachable=down
    state=${state:-"not answering"}
  fi
  if [ "$reachable" != "$last" ]; then
    echo "ems-link: $reachable — $state"
    last=$reachable
  fi
  sleep "${CFG_EMS_LINK_INTERVAL_SECONDS:-60}"
done
