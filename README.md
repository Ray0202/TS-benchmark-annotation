# Annotation Website

一个可部署到 GitHub Pages 的静态标注网站。

## 功能

- 首页填写标注者姓名、选择数据集、输入标注数量
- 标注页展示：
  - 题目 `prompt`
  - 历史时间序列
  - 历史协变量（多条时逐条展示）
  - 多项选择题（MCQ）
- 完成后可下载本次标注结果（`JSON` / `CSV`）
- 下载后可返回首页开始新一轮标注

## 目录结构

- `index.html`：入口页面
- `annotate.html`：标注页面
- `js/`：前端逻辑
- `css/`：样式
- `data/`：可直接被网页读取的数据
- `assets/plots/`：预生成静态图
- `scripts/`：数据构建与可视化脚本

## 1) 构建网站数据

在 `annotation_website` 目录执行：

```bash
python3 scripts/build_annotation_data.py
```

可选参数：

```bash
python3 scripts/build_annotation_data.py --max-per-dataset 50
```

默认从 `../../dataset/task_merged_new20_hf_no_answers_tiers.jsonl` 读取。

## 2) 生成时间序列静态图（可选）

```bash
python3 scripts/generate_visual_assets.py --dataset-file data/datasets/causal_chambers.json --max-items 20
python3 scripts/generate_visual_assets.py --dataset-file data/datasets/MIMIC.json --max-items 20
python3 scripts/generate_visual_assets.py --dataset-file data/datasets/PSML.json --max-items 20
python3 scripts/generate_visual_assets.py --dataset-file data/datasets/freshretailnet.json --max-items 20
```

如果没有预生成图，网页会自动回退到浏览器内置 Canvas 绘图。

## 3) 本地预览

```bash
python3 -m http.server 8000
```

然后访问：

- `http://localhost:8000/index.html`

## 4) 部署到 GitHub Pages

将 `annotation_website` 作为 Pages 发布目录（或将其内容放在 Pages 根目录）。

注意：

- 这是纯静态站点，不依赖后端。
- 标注结果下载由浏览器本地生成文件，不会自动上传到服务器。
