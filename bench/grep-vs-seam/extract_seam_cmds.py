# Emit one Seam invocation per line (flags only, wrapper stripped) from stored transcripts.
import json, sys
for path in sys.argv[1:]:
    try: lines = open(path)
    except OSError: continue
    for line in lines:
        try: d = json.loads(line)
        except Exception: continue
        c = (d.get('message') or {}).get('content') or []
        if not isinstance(c, list): continue
        for x in c:
            if not (isinstance(x, dict) and x.get('type') == 'tool_use' and x.get('name') == 'Bash'): continue
            cmd = (x.get('input') or {}).get('command', '')
            if 'decompose.ts' not in cmd: continue
            for part in cmd.split('&&'):
                if 'decompose.ts' not in part: continue
                body = part.split('decompose.ts', 1)[1]
                body = body.split('>')[0].split('2>')[0]
                body = ' '.join(body.split())
                if body: print(body)
