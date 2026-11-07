#!/bin/bash
cd "$(dirname "$0")"
source .venv/bin/activate
python init_index.py >> data/indexing.log 2>&1
