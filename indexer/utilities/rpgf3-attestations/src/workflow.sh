#!/bin/bash
python src/oss-directory.py
python src/fetch_from_eas.py
python src/analyze_apps.py
python src/canonical.py
#python src/reviewer.py