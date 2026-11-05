#!/bin/bash
cd /Users/neo/Development/perso/BookishApp
source .venv/bin/activate
python init_index.py >> data/indexing.log 2>&1
