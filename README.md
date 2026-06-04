# File Filter

An [Obsidian](https://obsidian.md) plugin that adds a live filter to the Files pane. Type a string and only matching files are shown — folder structure is preserved so you can see exactly where each file lives.

## How to use

Click the **search icon** in the Files pane (leftmost button in the nav bar). A search field appears below the buttons.

Type anything — the filter matches against the full file path, including folder names. So searching `boston` would surface:

```
Notes/
  Locations/
    Boston.md
Food/
  Pies/
    Boston Creme Pie.md
```

Press **Escape** or click **×** to clear the filter and return to the normal view.

## Behaviour

- Matches any substring of the full path (case-insensitive)
- Folder hierarchy is preserved for every matching file
- Collapsed folders that contain matches are automatically expanded while the filter is active, then restored when cleared
- All file types are included, not just Markdown notes
