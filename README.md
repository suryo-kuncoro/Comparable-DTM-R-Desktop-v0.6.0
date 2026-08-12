# Comparable DTM R Desktop v0.6.0 — Raster + Final Point Cloud

Versi ini memperluas Comparable DTM agar **tepat dua model** dapat dibandingkan dengan input campuran:

- `.tif/.tiff` → DTM raster
- `.las/.laz` → final/classified point cloud sebelum generate DTM

Nama Model 1 dan Model 2 tetap bebas.

## Kombinasi yang didukung

```text
DTM Raster   vs DTM Raster
Point Cloud  vs Point Cloud
Point Cloud  vs DTM Raster
DTM Raster   vs Point Cloud
```

## Auto Detect

Jenis input dideteksi dari ekstensi file. Tidak ada dropdown tipe input.

## Raster

Raster diproses langsung menggunakan `terra::extract()`:

- `simple`
- `bilinear`

## Point Cloud

Point cloud **tidak dibuat menjadi DTM raster sementara**.

Workflow:

```text
LAS / LAZ final
    ↓
project GCP ke CRS point cloud
    ↓
clip neighborhood pada tiap GCP
    ↓
pilih ground points
    ↓
estimasi Z tepat di XY GCP
    ↓
residual terhadap Z GCP
```

### Ground Point Rule

#### Auto

Default.

- Bila Classification 2 ditemukan → gunakan Class 2.
- Bila tidak ada Class 2 dan neighborhood hanya memiliki satu kelas → diasumsikan ground-only, seluruh titik digunakan.
- Bila Classification tidak tersedia → diasumsikan ground-only, dengan warning pada log.
- Bila multi-class tetapi Class 2 tidak tersedia → proses dihentikan untuk mencegah vegetasi/objek lain masuk ke estimasi terrain.

#### Force Classification = 2

Selalu menggunakan titik Class 2.

#### Use all points

Gunakan hanya bila input memang sudah berupa ground-only/final ground point cloud.

## Point Cloud Z Estimator

### IDW k-nearest — default

Default:

```text
Search radius = 2.0 m
k             = 8
power         = 2.0
```

Di dalam radius pencarian, k titik ground terdekat dipilih lalu elevasi diperkirakan dengan inverse distance weighting.

### Nearest

Mengambil Z ground point terdekat dari GCP.

## Mengapa tidak otomatis membuat DTM?

Tujuan mode point cloud adalah mengevaluasi **hasil klasifikasi/final ground cloud sebelum rasterisasi**.
Membuat DTM terlebih dahulu akan menambahkan faktor:

- resolusi raster,
- posisi grid,
- algoritma interpolasi raster.

Karena itu v0.6.0 melakukan sampling langsung dari ground point cloud.

## Fair Comparison

Ranking kedua model menggunakan subset:

```text
COMMON VALID GCP
```

Titik masuk ranking hanya bila:

- Z referensi valid,
- Model 1 menghasilkan Z valid,
- Model 2 menghasilkan Z valid.

Dengan demikian kedua RMSE dihitung pada titik GCP yang sama.

## Metrics

- Bias
- RMSE
- SD residual
- MAE
- Median Error
- R²
- LE90
- LE95
- Minimum residual
- Maximum residual

Residual:

```text
Residual = Z_model - Z_referensi
```

## Dependencies runtime

### Wajib

```r
terra
```

### Hanya bila menggunakan LAS/LAZ

```r
lidR
```

`sf` digunakan melalui workflow CRS point cloud dan biasanya merupakan dependency pada environment lidR.

Aplikasi **tidak melakukan instalasi package otomatis**.

Jika PC perusahaan sudah memiliki environment R 4.2.2 + lidR yang digunakan pada workflow SawitHeight/lidR, pilih `Rscript.exe` dari environment tersebut.

## Output per run

```text
run_YYYY-MM-DDTHH-MM-SS/
├── run_config.json
├── runtime_config.tsv
├── analysis.log
├── comparison_points.csv
├── summary_metrics.csv
├── gcp_residuals.gpkg
├── qc_rmse_comparison.png
├── qc_scatter_model1.png
├── qc_scatter_model2.png
├── qc_residual_boxplot.png
├── result_summary.json
├── output_manifest.csv
└── report.html
```

Untuk point cloud, `comparison_points.csv` juga menambahkan jumlah titik neighborhood yang ditemukan pada masing-masing GCP.

## Portable EXE / PC Perusahaan

Seperti versi desktop sebelumnya, Node/npm hanya diperlukan ketika **build**.

PC pengguna tidak perlu Node/npm setelah Portable EXE selesai dibuat.

Workflow GitHub Actions tetap tersedia:

```text
.github/workflows/build-windows.yml
```

Artifact:

```text
Comparable-DTM-R-Portable-0.6.0.exe
```

Target executable tetap menggunakan:

```text
requestExecutionLevel: user
```

sehingga aplikasi tidak meminta elevation Administrator dari konfigurasi Electron Builder.

Kebijakan AppLocker/antivirus perusahaan tetap dapat membatasi executable portable sesuai policy internal.

## Catatan point cloud besar

Mode point cloud menggunakan `lidR::readLAScatalog()` dan `clip_circle()` sehingga aplikasi membaca neighborhood di sekitar GCP, bukan sengaja memuat seluruh acquisition sebagai satu data.frame.

Untuk LAS/LAZ berukuran besar, spatial index `.lax` dapat membantu query area lokal bila tersedia, tetapi bukan syarat wajib aplikasi.
