# Manufacturing Support Database - Network Deployment

This app can run from a mapped network drive as a double-click launcher.

## Recommended Shared Folder

Create one folder on the mapped drive, for example:

```text
M:\Manufacturing Support Database\
```

Copy these into that folder:

```text
omnify_search_app.py
omnify_search_static\
Omnify_All_Parts_Cleaned\
Launch Manufacturing Support Database.bat
Build Shared Database.bat
```

## Build or Refresh the Shared Database

On one computer with Python installed, double-click:

```text
Build Shared Database.bat
```

That creates or refreshes:

```text
omnify_search.sqlite
```

in the shared folder.

Run this again after the scraped/cleaned Omnify data changes.

## User Launch

Users double-click:

```text
Launch Manufacturing Support Database.bat
```

The launcher copies the shared SQLite database to:

```text
%LOCALAPPDATA%\ManufacturingSupportDatabase\
```

Then it starts the local web app and opens the browser at:

```text
http://127.0.0.1:8765
```

Each user gets their own local database copy, so multiple people can use the app at the same time without locking the shared database.

## Python Requirement

The batch launcher requires Python 3 on each computer. For a true "anyone can open it" package with no Python install, build an EXE with PyInstaller and place the EXE in the shared folder with `omnify_search_static`, `omnify_search.sqlite`, and `Omnify_All_Parts_Cleaned`.

## Best Practice

Keep the scraped files and database together in the same shared folder. That keeps document downloads working for every user instead of pointing to one person's local Downloads folder.
