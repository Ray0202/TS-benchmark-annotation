#!/usr/bin/env python3
import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path


def load_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def load_task_modified_records(paths):
    records = []
    for path in paths:
        p = Path(path)
        if not p.exists():
            continue
        dataset_rows = json.load(p.open("r", encoding="utf-8"))
        for sample in dataset_rows:
            dataset_name = sample.get("dataset") or p.parts[-3]
            sample_id = sample.get("sample_id")
            tasks = sample.get("tasks") or {}
            if not isinstance(tasks, dict):
                continue
            for tier, task_obj in tasks.items():
                if not isinstance(task_obj, dict):
                    continue
                rec = {
                    "id": f"{sample_id}_{tier}",
                    "tier": tier,
                    "sample_id": sample_id,
                    "source_dataset": dataset_name,
                    "task": task_obj.get("task"),
                    "prompt": task_obj.get("prompt", ""),
                    "meta": sample.get("meta") or {},
                    "mcq": build_mcq_dict_from_task(task_obj),
                    "input": task_obj.get("input"),
                    "t4_prompt": (tasks.get("T4") or {}).get("prompt", "") if isinstance(tasks.get("T4"), dict) else "",
                }
                records.append(rec)
    return records


def load_task_modified_example_records(paths):
    records = []
    for path in paths:
        p = Path(path)
        if not p.exists():
            continue
        dataset_rows = json.load(p.open("r", encoding="utf-8"))
        for sample in dataset_rows:
            dataset_name = sample.get("dataset") or p.parts[-3]
            sample_id = sample.get("sample_id")
            tasks = sample.get("tasks") or {}
            if not isinstance(tasks, dict):
                continue
            for tier, task_obj in tasks.items():
                if not isinstance(task_obj, dict):
                    continue
                rec = {
                    "id": f"{sample_id}_{tier}",
                    "tier": tier,
                    "sample_id": sample_id,
                    "source_dataset": dataset_name,
                    "task": task_obj.get("task"),
                    "prompt": task_obj.get("prompt", ""),
                    "meta": sample.get("meta") or {},
                    "mcq": build_mcq_dict_from_task(task_obj),
                    "input": task_obj.get("input"),
                    "t4_prompt": (tasks.get("T4") or {}).get("prompt", "") if isinstance(tasks.get("T4"), dict) else "",
                    "reference_answers": build_reference_answers(task_obj),
                }
                records.append(rec)
    return records


def as_list(v):
    return v if isinstance(v, list) else []


def is_numeric_list(v):
    if not isinstance(v, list) or not v:
        return False
    for x in v:
        if x is None:
            continue
        if not isinstance(x, (int, float)):
            return False
    return True


def sanitize_number(x):
    if isinstance(x, float) and not math.isfinite(x):
        return None
    return x


def sanitize_obj(obj):
    if isinstance(obj, dict):
        return {k: sanitize_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_obj(v) for v in obj]
    return sanitize_number(obj)


def split_prompt_and_input(prompt):
    text = prompt or ""
    cut = len(text)
    for pat in [r"\n\nInput\b", r"\nInput\b"]:
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            cut = min(cut, m.start())
    cleaned = text[:cut].strip()
    input_part = text[cut:].strip() if cut < len(text) else ""
    return cleaned, input_part


def remove_question_block(prompt_text):
    if not prompt_text:
        return ""
    text = prompt_text
    lines = text.splitlines()
    kept = []
    stop = False
    for ln in lines:
        low = ln.strip().lower()
        if (
            low.startswith("multiple-choice questions")
            or low.startswith("questions:")
            or re.match(r"^q\d+\)", low)
        ):
            stop = True
        if stop:
            continue
        if "multiple-choice question" in low:
            continue
        kept.append(ln)
    return "\n".join(kept).strip()


def extract_mcq_from_prompt(prompt_text):
    if not prompt_text:
        return []
    mcq = []
    lines = prompt_text.splitlines()
    for ln in lines:
        s = ln.strip()
        m = re.match(r"^(?:Q\s*)?(\d+)[\)\:\.]?\s*(.+?)\s*\{(.+)\}\s*$", s, flags=re.IGNORECASE)
        if not m:
            m = re.match(r"^Q(\d+)\)\s*(.+?)\s*\{(.+)\}\s*$", s, flags=re.IGNORECASE)
        if not m:
            continue
        idx = m.group(1)
        question = m.group(2).strip()
        opts_raw = m.group(3).strip().strip("{}")
        opts_raw = re.sub(r"\}+\s*$", "", opts_raw)
        options = [o.strip().strip('"').strip("'") for o in opts_raw.split(",")]
        options = [o for o in options if o]
        if len(options) < 2:
            continue
        mcq.append({"key": f"q{idx}", "question": question, "options": options})
    return mcq


def extract_questions_from_prompt(prompt_text):
    if not prompt_text:
        return []
    lines = prompt_text.splitlines()
    in_questions = False
    out = []
    for ln in lines:
        s = ln.strip()
        low = s.lower()
        if low.startswith("questions:"):
            in_questions = True
            continue
        if not in_questions:
            continue
        if low.startswith("output format") or low.startswith("constraints:"):
            break
        m = re.match(r"^-?\s*Q(\d+)\s*:\s*(.+)$", s, flags=re.IGNORECASE)
        if not m:
            continue
        qid = m.group(1)
        body = m.group(2).strip()
        options = []
        opt_m = re.search(r"\(\s*Options?\s*:\s*(.+?)\s*\)\s*$", body, flags=re.IGNORECASE)
        if opt_m:
            options = [x.strip().strip('"').strip("'") for x in opt_m.group(1).split(",")]
            options = [x for x in options if x]
            body = re.sub(r"\(\s*Options?\s*:\s*.+?\s*\)\s*$", "", body, flags=re.IGNORECASE).strip()
        out.append({"key": f"q{qid}", "question": body, "options": options})
    return out


def infer_options_from_question(question):
    q = (question or "").strip()
    low = q.lower()

    if "earlier or later" in low:
        return ["Earlier", "Later", "No clear shift", "Uncertain"]
    if low.startswith(("is ", "are ", "do ", "does ", "did ", "can ", "could ", "has ", "have ")):
        return ["Yes", "No", "Uncertain"]
    if re.search(r"\b(is|are|do|does|did|can|could|has|have)\b.*\?$", low):
        return ["Yes", "No", "Uncertain"]
    if "whose" in low or "higher than" in low:
        return ["Higher", "Lower", "Similar", "Uncertain"]
    if "trend" in low:
        return ["Upward", "Downward", "Stable", "Uncertain"]
    if low.startswith("when ") or "when does" in low or "response" in low:
        return ["Immediate", "Short lag", "Long lag", "Uncertain"]
    if "how long" in low:
        return ["Short", "Medium", "Long", "Uncertain"]
    return ["A", "B", "C", "Uncertain"]


def extract_general_t4_context(t4_prompt):
    if not t4_prompt:
        return ""
    lines = t4_prompt.splitlines()
    kept = []
    in_field_meanings = False
    in_data_schema = False
    for ln in lines:
        s = ln.strip()
        low = s.lower()
        if low.startswith("input") or low.startswith("questions:") or low.startswith("output format") or low.startswith("constraints:"):
            break
        if low.startswith("history summary"):
            break
        if low.startswith("event context") or low.startswith("upcoming event") or "will occur soon" in low:
            in_field_meanings = False
            in_data_schema = False
            continue
        if low.startswith("field meanings"):
            in_field_meanings = True
            in_data_schema = False
            kept.append(ln)
            continue
        if low.startswith("data schema"):
            in_data_schema = True
            in_field_meanings = False
            kept.append(ln)
            continue
        if low.startswith("task:"):
            in_field_meanings = False
            in_data_schema = False
            continue

        # Keep only generally reusable context blocks.
        if in_field_meanings or in_data_schema:
            kept.append(ln)

    # Fallback: if nothing captured, keep only first non-event paragraph.
    if not any(x.strip() for x in kept):
        for ln in lines:
            s = ln.strip()
            low = s.lower()
            if not s:
                if kept:
                    break
                continue
            if re.search(r"(event|holiday|upcoming|future|history summary)", low):
                continue
            if low.startswith("field meanings") or low.startswith("task:") or low.startswith("input"):
                break
            kept.append(ln)
    return "\n".join(kept).strip()


def enrich_t3_prompt(base_prompt, t4_prompt):
    base = (base_prompt or "").strip()
    ctx = extract_general_t4_context(t4_prompt)
    if not ctx:
        return base
    # Keep T3 prompt first, then append missing general context blocks from T4.
    if "Field meanings" in base:
        return base
    return f"{base}\n\n{ctx}".strip()


def build_mcq_dict_from_task(task_obj):
    mcq_dict = {}
    pack = task_obj.get("pack")
    if isinstance(pack, list) and pack:
        for i, item in enumerate(pack, start=1):
            if not isinstance(item, dict):
                continue
            q = item.get("question")
            opts = item.get("label_space") or item.get("options") or []
            if not isinstance(opts, list):
                opts = []
            opts = [str(x).strip() for x in opts if str(x).strip()]
            if q and opts:
                mcq_dict[f"q{i}"] = {"question": q, "options": opts}
    return mcq_dict


def build_reference_answers(task_obj):
    refs = {}
    pack = task_obj.get("pack")
    if isinstance(pack, list) and pack:
        for i, item in enumerate(pack, start=1):
            if not isinstance(item, dict):
                continue
            label = item.get("label")
            if label is not None:
                refs[f"q{i}"] = str(label)

    labels = task_obj.get("labels")
    if isinstance(labels, dict) and labels:
        i = 1
        for _, val in labels.items():
            refs[f"q{i}"] = str(val)
            i += 1

    mcq = task_obj.get("mcq")
    if isinstance(mcq, dict) and mcq:
        i = 1
        for _, item in mcq.items():
            if not isinstance(item, dict):
                i += 1
                continue
            label = item.get("label")
            if label is not None:
                refs[f"q{i}"] = str(label)
            i += 1
    elif isinstance(mcq, list) and mcq:
        for i, item in enumerate(mcq, start=1):
            if not isinstance(item, dict):
                continue
            label = item.get("label")
            if label is not None:
                refs[f"q{i}"] = str(label)
    return refs


def parse_json_blob(text):
    if not text:
        return None
    decoder = json.JSONDecoder()
    best = None
    best_len = -1
    # Also try a lenient variant because some prompts may contain NaN/Infinity tokens.
    text_candidates = [text, re.sub(r"\bNaN\b|\bInfinity\b|\b-Infinity\b", "null", text)]
    for candidate in text_candidates:
        for i, ch in enumerate(candidate):
            if ch not in "[{":
                continue
            try:
                obj, end = decoder.raw_decode(candidate[i:])
                if end > best_len:
                    best = obj
                    best_len = end
            except json.JSONDecodeError:
                continue
    return best


def infer_series_from_payload(payload, target_key):
    history = {"key": None, "timestamps": [], "values": []}
    cov = {"timestamps": [], "covariates": {}}
    future_cov = {"timestamps": [], "covariates": {}}

    if isinstance(payload, list):
        if payload and isinstance(payload[0], dict) and "value" in payload[0]:
            history["timestamps"] = [row.get("timestamp") for row in payload]
            history["values"] = [row.get("value") for row in payload]
            history["key"] = target_key
        return history, cov, future_cov

    if not isinstance(payload, dict):
        return history, cov, future_cov

    # Pattern: {"history": {...}, "future_covariates": {...}}
    if isinstance(payload.get("history"), dict):
        h = payload["history"]
        history["timestamps"] = as_list(h.get("timestamps"))
        history["values"] = as_list(h.get("values")) or as_list(h.get("target"))
        history["key"] = h.get("key") or target_key
        cov["timestamps"] = as_list(h.get("timestamps"))
        cov["covariates"] = h.get("covariates") or {}

        # Some datasets store history directly as multivariate arrays:
        # {"history":{"series_a":[...], "series_b":[...], ...}}
        if not history["values"]:
            h_numeric = {k: v for k, v in h.items() if is_numeric_list(v)}
            if h_numeric:
                pick_key = target_key if target_key in h_numeric else next(iter(h_numeric.keys()))
                history["key"] = pick_key
                history["values"] = h_numeric[pick_key]
                if not history["timestamps"]:
                    tod = h_numeric.get("time_position_in_day")
                    history["timestamps"] = tod if is_numeric_list(tod) and len(tod) == len(history["values"]) else list(
                        range(len(history["values"]))
                    )
                if not cov["covariates"]:
                    cov["covariates"] = {k: v for k, v in h_numeric.items() if k != pick_key}
                    cov["timestamps"] = history["timestamps"]

    if isinstance(payload.get("future_covariates"), dict):
        fc = payload["future_covariates"]
        future_cov["timestamps"] = as_list(fc.get("timestamps"))
        future_cov["covariates"] = fc.get("covariates") or {}

    # Pattern: {"heart_rate":[...], "temperature_c":[...], ...}
    numeric_fields = {k: v for k, v in payload.items() if is_numeric_list(v)}
    if numeric_fields and not history["values"]:
        pick_key = target_key if target_key in numeric_fields else next(iter(numeric_fields.keys()))
        history["key"] = pick_key
        history["values"] = numeric_fields[pick_key]
        tod = numeric_fields.get("time_position_in_day")
        history["timestamps"] = tod if is_numeric_list(tod) and len(tod) == len(history["values"]) else list(
            range(len(history["values"]))
        )

    if numeric_fields and not cov["covariates"]:
        cov["timestamps"] = list(range(len(history["values"]))) if history["values"] else []
        cov["covariates"] = {k: v for k, v in numeric_fields.items() if k != history["key"]}
        if history["timestamps"]:
            cov["timestamps"] = history["timestamps"]

    return history, cov, future_cov


def normalize_record(rec):
    raw_prompt = rec.get("prompt", "")
    input_obj = rec.get("input") or {}
    history = rec.get("history") or input_obj.get("history") or {}
    future = rec.get("future") or input_obj.get("future") or {}
    history_cov = rec.get("history_covariates") or input_obj.get("history_covariates") or {}
    future_cov = rec.get("future_covariates") or input_obj.get("future_covariates") or {}

    mcq_dict = rec.get("mcq") or input_obj.get("mcq") or {}
    mcq_list = []
    for key, cfg in mcq_dict.items():
        question = cfg.get("question") if isinstance(cfg, dict) else None
        options = as_list(cfg.get("options")) if isinstance(cfg, dict) else []
        if not question or not options:
            continue
        mcq_list.append({"key": key, "question": question, "options": options})
    prompt_questions = extract_questions_from_prompt(raw_prompt)
    if str(rec.get("tier")) == "T3":
        # For T3, prefer source MCQ options from pack/mcq fields.
        # Prompt-derived questions are only a fallback when source options are absent.
        if not mcq_list and prompt_questions:
            for q in prompt_questions:
                if not q.get("options"):
                    q["options"] = infer_options_from_question(q.get("question", ""))
            mcq_list = prompt_questions
    elif not mcq_list:
        mcq_list = extract_mcq_from_prompt(raw_prompt)

    hist_timestamps = as_list(history.get("timestamps"))
    hist_values = as_list(history.get("values"))
    if not hist_values:
        hist_values = as_list(history.get("target"))

    hist_covariates = history_cov.get("covariates") or {}
    if not hist_covariates:
        hist_covariates = history.get("covariates") or {}
    hist_cov_timestamps = as_list(history_cov.get("timestamps"))
    if not hist_cov_timestamps:
        hist_cov_timestamps = hist_timestamps

    cleaned_prompt, input_part = split_prompt_and_input(raw_prompt)
    cleaned_prompt = remove_question_block(cleaned_prompt)
    if str(rec.get("tier")) == "T3":
        cleaned_prompt = enrich_t3_prompt(cleaned_prompt, rec.get("t4_prompt", ""))
    inferred_payload = parse_json_blob(input_part)
    inferred_history, inferred_cov, inferred_future_cov = infer_series_from_payload(
        inferred_payload, (rec.get("meta") or {}).get("target")
    )

    if not hist_values:
        hist_values = inferred_history["values"]
        hist_timestamps = inferred_history["timestamps"]
    hist_key = history.get("key") or inferred_history["key"]

    # Pattern: history is directly a dict of series {"heart_rate":[...], ...}
    history_numeric_fields = {k: v for k, v in history.items() if is_numeric_list(v)}
    if history_numeric_fields and not hist_values:
        target_key = (rec.get("meta") or {}).get("target")
        hist_key = target_key if target_key in history_numeric_fields else next(iter(history_numeric_fields.keys()))
        hist_values = history_numeric_fields[hist_key]
        tod = history_numeric_fields.get("time_position_in_day")
        hist_timestamps = tod if is_numeric_list(tod) and len(tod) == len(hist_values) else list(range(len(hist_values)))
    if history_numeric_fields and not hist_covariates:
        hist_covariates = {k: v for k, v in history_numeric_fields.items() if k != hist_key}
        hist_cov_timestamps = hist_timestamps if hist_values else []

    if not hist_covariates:
        hist_covariates = inferred_cov["covariates"]
        hist_cov_timestamps = inferred_cov["timestamps"]

    fut_covariates = future_cov.get("covariates") or {}
    fut_cov_timestamps = as_list(future_cov.get("timestamps"))
    # Pattern: future_covariates is directly a dict of series.
    future_cov_numeric_fields = {k: v for k, v in future_cov.items() if is_numeric_list(v)}
    if future_cov_numeric_fields and not fut_covariates:
        fut_covariates = future_cov_numeric_fields
        any_len = len(next(iter(fut_covariates.values()))) if fut_covariates else 0
        fut_cov_timestamps = list(range(any_len))
    if not fut_covariates:
        fut_covariates = inferred_future_cov["covariates"]
        fut_cov_timestamps = inferred_future_cov["timestamps"]

    normalized = {
        "id": rec.get("id"),
        "tier": rec.get("tier"),
        "sample_id": rec.get("sample_id"),
        "source_dataset": rec.get("source_dataset"),
        "task": rec.get("task"),
        "prompt": cleaned_prompt,
        "meta": {
            "target": (rec.get("meta") or {}).get("target"),
            "future_len": (rec.get("meta") or {}).get("future_len"),
        },
        "history": {
            "key": hist_key,
            "timestamps": hist_timestamps,
            "values": hist_values,
        },
        "future": {
            "timestamps": as_list(future.get("timestamps")),
            "values": as_list(future.get("values")),
        },
        "history_covariates": {
            "timestamps": hist_cov_timestamps,
            "covariates": hist_covariates,
        },
        "future_covariates": {
            "timestamps": fut_cov_timestamps,
            "covariates": fut_covariates,
        },
        "mcq": mcq_list,
        "plot_paths": {
            "history": None,
            "covariates": {}
        },
        "reference_answers": rec.get("reference_answers") or {},
    }
    return normalized


def main():
    parser = argparse.ArgumentParser(description="Build web-ready annotation data files")
    parser.add_argument(
        "--input",
        default="task_modified",
        help="Path to source JSONL or 'task_modified' to use dataset/*/results/task_modified.json",
    )
    parser.add_argument(
        "--output-dir",
        default="./data",
        help="Output directory under annotation_website",
    )
    parser.add_argument(
        "--max-per-dataset",
        type=int,
        default=0,
        help="Optional cap per dataset (0 means no cap)",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    output_dir = (script_dir.parent / args.output_dir).resolve()
    datasets_dir = output_dir / "datasets"
    examples_root = output_dir / "examples"
    examples_datasets_dir = examples_root / "datasets"

    datasets_dir.mkdir(parents=True, exist_ok=True)
    examples_datasets_dir.mkdir(parents=True, exist_ok=True)

    input_arg = args.input.strip()
    if input_arg == "task_modified":
        source_paths = [
            script_dir.parent.parent / "dataset" / "causal_chambers" / "results" / "task_modified.json",
            script_dir.parent.parent / "dataset" / "freshretailnet" / "results" / "task_modified.json",
            script_dir.parent.parent / "dataset" / "MIMIC" / "results" / "task_modified.json",
            script_dir.parent.parent / "dataset" / "PSML" / "results" / "task_modified.json",
        ]
        raw_records = load_task_modified_records(source_paths)
    else:
        input_path = (script_dir / input_arg).resolve()
        raw_records = list(load_jsonl(input_path))

    grouped = defaultdict(list)
    for rec in raw_records:
        norm = normalize_record(rec)
        ds_name = norm.get("source_dataset") or "unknown"
        if args.max_per_dataset and len(grouped[ds_name]) >= args.max_per_dataset:
            continue
        grouped[ds_name].append(sanitize_obj(norm))

    # Build examples from task_modified_new20-like files.
    example_source_paths = [
        script_dir.parent.parent / "dataset" / "causal_chambers" / "results" / "task_modified_new20.json",
        script_dir.parent.parent / "dataset" / "freshretailnet" / "results" / "task_modified_new20.json",
        script_dir.parent.parent / "dataset" / "MIMIC" / "results" / "task_modified_new20.json",
        script_dir.parent.parent / "dataset" / "PSML" / "results" / "task_modified_new20.json",
        script_dir.parent.parent / "dataset" / "PSML" / "results" / "task_modified_incremental.json",
    ]
    example_records = load_task_modified_example_records(example_source_paths)
    ex_grouped = defaultdict(list)
    for rec in example_records:
        norm = normalize_record(rec)
        ds_name = norm.get("source_dataset") or "unknown"
        if str(norm.get("tier") or "") not in {"T3", "T4"}:
            continue
        # keep only records that have explicit reference answers
        if not norm.get("reference_answers"):
            continue
        ex_grouped[ds_name].append(sanitize_obj(norm))

    catalog = []
    for ds_name, items in sorted(grouped.items()):
        filename = f"{ds_name}.json"
        target = datasets_dir / filename
        with target.open("w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, allow_nan=False)

        catalog.append(
            {
                "dataset": ds_name,
                "count": len(items),
                "file": f"data/datasets/{filename}",
            }
        )

    with (output_dir / "catalog.json").open("w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2, allow_nan=False)

    examples_catalog = []
    for ds_name, items in sorted(ex_grouped.items()):
        filename = f"{ds_name}.json"
        target = examples_datasets_dir / filename
        with target.open("w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, allow_nan=False)
        examples_catalog.append(
            {
                "dataset": ds_name,
                "count": len(items),
                "file": f"data/examples/datasets/{filename}",
            }
        )

    with (examples_root / "catalog.json").open("w", encoding="utf-8") as f:
        json.dump(examples_catalog, f, ensure_ascii=False, indent=2, allow_nan=False)

    total = sum(item["count"] for item in catalog)
    print(f"Built {len(catalog)} datasets, total records: {total}")
    print(f"Catalog: {output_dir / 'catalog.json'}")
    ex_total = sum(item["count"] for item in examples_catalog)
    print(f"Examples datasets: {len(examples_catalog)}, total records: {ex_total}")


if __name__ == "__main__":
    main()
