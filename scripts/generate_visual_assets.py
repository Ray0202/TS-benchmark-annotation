#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def clean_numeric(values):
    out = []
    for v in values:
        if v is None:
            out.append(float("nan"))
        else:
            out.append(v)
    return out


def plot_series(values, title, out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    y = clean_numeric(values)
    x = list(range(len(y)))

    fig, ax = plt.subplots(figsize=(10, 3.2), dpi=120)
    ax.plot(x, y, linewidth=1.4, color="#1f77b4")
    ax.set_title(title, fontsize=10)
    ax.set_xlabel("Step")
    ax.set_ylabel("Value")
    ax.grid(alpha=0.25, linestyle="--")
    fig.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description="Generate static time-series plots for annotation website")
    parser.add_argument("--dataset-file", required=True, help="Path to normalized dataset JSON")
    parser.add_argument("--plots-root", default="./assets/plots", help="Output plots root")
    parser.add_argument("--max-items", type=int, default=0, help="Optional max items to generate")
    args = parser.parse_args()

    dataset_file = Path(args.dataset_file).resolve()
    website_root = dataset_file.parents[2]
    plots_root = (website_root / args.plots_root).resolve()

    with dataset_file.open("r", encoding="utf-8") as f:
        records = json.load(f)

    targets = records[: args.max_items] if args.max_items > 0 else records

    generated = 0
    for item in targets:
        item_id = item.get("id") or f"item_{generated}"
        ds = item.get("source_dataset") or "unknown"

        history_values = (item.get("history") or {}).get("values") or []
        if history_values:
            hist_path = plots_root / ds / item_id / "history.png"
            title = f"{item_id} | history"
            plot_series(history_values, title, hist_path)
            rel_path = hist_path.relative_to(website_root).as_posix()
            item.setdefault("plot_paths", {})["history"] = rel_path

        covariates = ((item.get("history_covariates") or {}).get("covariates") or {})
        cov_paths = item.setdefault("plot_paths", {}).setdefault("covariates", {})
        for cov_name, cov_values in covariates.items():
            if not cov_values:
                continue
            cov_path = plots_root / ds / item_id / f"cov_{cov_name}.png"
            title = f"{item_id} | covariate: {cov_name}"
            plot_series(cov_values, title, cov_path)
            cov_paths[cov_name] = cov_path.relative_to(website_root).as_posix()

        generated += 1

    with dataset_file.open("w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)

    print(f"Generated plot assets for {generated} records: {dataset_file}")


if __name__ == "__main__":
    main()
