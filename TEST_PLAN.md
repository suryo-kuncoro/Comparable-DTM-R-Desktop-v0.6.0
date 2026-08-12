# Test Plan — Comparable DTM R v0.6.0

## Supported combinations

- Raster vs Raster
- LAS/LAZ vs LAS/LAZ
- Raster vs LAS/LAZ
- LAS/LAZ vs Raster

## Point cloud

Test:

1. Classified cloud dengan Class 2.
2. Ground-only cloud dengan satu class non-2.
3. Ground-only cloud tanpa Classification.
4. Multi-class tanpa Class 2 -> fail pada Auto.
5. Force Class 2.
6. Use all points.
7. Radius terlalu kecil hingga sebagian GCP NA.
8. IDW.
9. Nearest.
10. CRS GCP berbeda dari LAS/LAZ.
11. Empty neighborhood pada beberapa GCP.
12. LAS dan LAZ.

## Raster

- Simple.
- Bilinear.
- CRS berbeda.
- NoData pada sebagian GCP.

## Common GCP

Pastikan ranking memakai subset valid yang sama pada kedua model.

## Output

- comparison_points.csv
- summary_metrics.csv
- gcp_residuals.gpkg
- qc_rmse_comparison.png
- qc_scatter_model1.png
- qc_scatter_model2.png
- qc_residual_boxplot.png
- result_summary.json
- output_manifest.csv
- report.html

## Desktop

- type badge berubah otomatis.
- progress/log.
- validate.
- run.
- cancel.
- report/dashboard.
