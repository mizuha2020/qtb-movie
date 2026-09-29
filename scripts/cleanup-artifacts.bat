@echo off
REM Xoa artifact hang loat tren repo mizuha2020/qtb-movie
REM Yeu cau: da chay `gh auth login` truoc
set REPO=mizuha2020/qtb-movie
set LIMIT=100

echo Liet ke artifact tren %REPO% ...
"C:\Program Files\GitHub CLI\gh.exe" api repos/%REPO%/actions/artifacts --paginate -q ".artifacts[] | [.id, .name, (.size_in_bytes/1048576|floor|tostring+\"MB\"), .created_at, .expired] | @tsv" | more

echo.
echo Xoa TAT CA artifact (can than trong)?
pause

for /f %%i in ('"C:\Program Files\GitHub CLI\gh.exe" api repos/%REPO%/actions/artifacts --paginate -q ".artifacts[].id"') do (
  echo Deleting artifact %%i ...
  "C:\Program Files\GitHub CLI\gh.exe" api --method DELETE repos/%REPO%/actions/artifacts/%%i
)
echo Xong!
pause
