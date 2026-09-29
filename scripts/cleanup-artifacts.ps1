# Xoa artifact hang loat tren repo mizuha2020/qtb-movie
# Yeu cau: da chay `gh auth login` truoc
$REPO = "mizuha2020/qtb-movie"
$GH = "gh"

Write-Host "=== Danh sach artifact ($REPO) ===" -ForegroundColor Cyan
& $GH api "repos/$REPO/actions/artifacts?per_page=100" --paginate -q '.artifacts[] | [.id, .name, (.size_in_bytes/1048576|floor|tostring+"MB"), .created_at, .expired] | @tsv'

Write-Host ""
$total = (& $GH api "repos/$REPO/actions/artifacts?per_page=100" --paginate -q '.total_count') | Select-Object -Last 1
Write-Host "Tong so artifact: $total" -ForegroundColor Yellow

$confirm = Read-Host "Ban co chac muon XOA TAT CA artifact? (ghi YES de xac nhan)"
if ($confirm -ne "YES") { Write-Host "Huy bo."; exit 0 }

Write-Host "Dang xoa..." -ForegroundColor Red
& $GH api "repos/$REPO/actions/artifacts?per_page=100" --paginate -q '.artifacts[].id' | ForEach-Object {
  $id = $_.Trim()
  if ($id) {
    Write-Host "Deleting artifact $id ..."
    & $GH api --method DELETE "repos/$REPO/actions/artifacts/$id" | Out-Null
  }
}
Write-Host "Xong! Cho 6-12h de GitHub cap nhat lai quota." -ForegroundColor Green
