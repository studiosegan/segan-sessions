-- Segan Sessions — the Dock app. Click it to start the studio (Chrome opens on it); click it again
-- while the studio runs to open it or stop it.
-- Source for "Segan Sessions.app": launcher/build-app.sh fills in the __PLACEHOLDERS__ below with
-- real paths when it builds the app, so the same launcher works installed or from a git checkout.

set appDir to "__APP_DIR__"
set nodeBin to "__NODE__"
set pidFile to "__SUPPORT__/server.pid"
set logFile to "__SUPPORT__/server.log"

-- Already running? The studio answers /api/health with its footage "library", which is how it is
-- told apart from anything else holding one of these ports.
set runningPort to do shell script "for p in 4321 4322 4323 4324 4325 4326 4327 4328 4329 4330 4331; do curl -s --max-time 1 http://127.0.0.1:$p/api/health 2>/dev/null | grep -q '\"library\"' && { echo $p; exit 0; }; done; true"

if runningPort is "" then
	do shell script "mkdir -p " & quoted form of "__SUPPORT__" & "; nohup " & quoted form of nodeBin & " " & quoted form of (appDir & "/server.js") & " --open > " & quoted form of logFile & " 2>&1 </dev/null & echo $! > " & quoted form of pidFile
	display notification "Starting… Chrome opens in a moment." with title "Segan Sessions"
else
	set studioUrl to "http://127.0.0.1:" & runningPort
	set answer to button returned of (display dialog "Segan Sessions is running." with title "Segan Sessions" buttons {"Stop", "Cancel", "Open"} default button "Open")
	if answer is "Open" then
		do shell script "open -a 'Google Chrome' " & studioUrl & " || open " & studioUrl
	else if answer is "Stop" then
		do shell script "if [ -f " & quoted form of pidFile & " ]; then kill $(cat " & quoted form of pidFile & ") 2>/dev/null; rm -f " & quoted form of pidFile & "; fi; pkill -f " & quoted form of (appDir & "/server.js") & " 2>/dev/null; true"
		display notification "Studio stopped." with title "Segan Sessions"
	end if
end if
