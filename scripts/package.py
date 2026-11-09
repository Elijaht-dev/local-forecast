"""Create the integration ZIP consumed by Home Assistant Marketplace."""

import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
component = root / "custom_components" / "local_forecast"
manifest = json.loads((component / "manifest.json").read_text(encoding="utf-8"))
if len(sys.argv) > 1 and manifest["version"] != sys.argv[1].removeprefix("v"):
    raise SystemExit("The release tag and manifest version differ")
if not (component / "frontend" / "forecast-lab.js").is_file():
    raise SystemExit("Build Forecast Lab with npm run build first")
output = root / "dist" / "local_forecast.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for path in sorted(component.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            archive.write(path, path.relative_to(component))
    archive.write(root / "LICENSE", "LICENSE")
print(output)
