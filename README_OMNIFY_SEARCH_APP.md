# Manufacturing Support Database

Local search UI for cleaned manufacturing support data.

## Start

Place cleaned data in:

```text
.\data\Omnify_All_Parts_Cleaned
```

Then run:

```powershell
python omnify_search_app.py --source ".\data\Omnify_All_Parts_Cleaned" --db ".\omnify_search.sqlite" --port 8765 --open-browser
```

Open:

http://127.0.0.1:8765

## Source Data

The app reads every `breakdown.json` and downloaded document metadata beneath each cleaned platform / description / part number folder.

## Rebuild

Use the `Rebuild index` button in the app after refreshing or adding scrape data.

The index database is:

`omnify_search.sqlite`
