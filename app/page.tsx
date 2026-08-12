"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  buildCompetitorManifest,
  buildCompetitorRecognition,
  createCompetitorEntry,
  listZipCompetitorEntries,
  type CompetitorUploadEntry,
} from "../lib/competitor-groups";
import { buildExcelWorkbook } from "../lib/excel-export";
import { NeigongWorkspace } from "../components/neigong/NeigongWorkspace";
import { createAsyncSessionGuard, isAbortError } from "../lib/async-session";

type ModuleKey =
  | "market"
  | "competitor"
  | "complete"
  | "detail"
  | "review"
  | "buyer";
type ResultView = "report" | "edit";
type CompetitorDimensionKey = "copy" | "visual" | "structure";

const MB = 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 50 * MB;
const MAX_UPLOAD_TOTAL_BYTES = 80 * MB;
const MAX_HOSTED_DIRECT_UPLOAD_BYTES = 850 * 1024;

const featuredModules: Array<{
  key: ModuleKey;
  order: string;
  title: string;
  description: string;
  flowLabel: string;
}> = [
  {
    key: "market",
    order: "01",
    title: "市场分析",
    description:
      "先看品牌、价格带、人群与卖点分布，筛出最值得正面对标的竞品。",
    flowLabel: "先定位市场",
  },
  {
    key: "competitor",
    order: "02",
    title: "多竞品对比分析",
    description:
      "同时识别多个竞品，横向拆解营销文案、视觉表达和页面框架。",
    flowLabel: "再横向拆对手",
  },
];

const specialistModules: Array<{
  key: ModuleKey;
  order: string;
  title: string;
  description: string;
}> = [
  {
    key: "detail",
    order: "03",
    title: "详情页分析",
    description: "拆解竞品每一屏，找到共性打法、差异机会与详情页方向。",
  },
  {
    key: "review",
    order: "04",
    title: "内功问诊",
    description: "对照默认与时间排序评价、前 20 六维和问大家，输出可追溯诊断。",
  },
  {
    key: "buyer",
    order: "05",
    title: "买家秀专项分析",
    description: "分析图片和文案结构，输出替换方向与可执行内容方案。",
  },
  {
    key: "complete",
    order: "06",
    title: "全链路分析",
    description:
      "一次汇总市场、竞品、详情页、评价区和买家秀，生成统一执行清单。",
  },
];

const analysisCopy: Record<
  ModuleKey,
  {
    uploadTitle: string;
    uploadDescription: string;
    resultTitle: string;
  }
> = {
  market: {
    uploadTitle: "市场与行业资料",
    uploadDescription:
      "上传行业表格、平台榜单、竞品清单、价格带或市场研究资料",
    resultTitle: "市场格局与对标竞品建议",
  },
  competitor: {
    uploadTitle: "多个竞品资料",
    uploadDescription:
      "每个竞品单独建立文件夹，上传主副图、详情页、文案或成品资料包",
    resultTitle: "多竞品拆解与对抗方案",
  },
  complete: {
    uploadTitle: "全链路待分析资料",
    uploadDescription:
      "上传包含市场、竞品、详情页、评价区和买家秀目录的 ZIP 或文件夹",
    resultTitle: "全链路商品分析方案",
  },
  detail: {
    uploadTitle: "竞品详情页资料",
    uploadDescription: "上传竞品长图、逐屏截图或文字资料",
    resultTitle: "竞品详情页分析方案",
  },
  review: {
    uploadTitle: "评价区资料",
    uploadDescription: "上传评价标签、追评、问大家等截图",
    resultTitle: "评价区全盘优化方案",
  },
  buyer: {
    uploadTitle: "买家秀资料",
    uploadDescription: "上传买家秀图片、文案与跟评截图",
    resultTitle: "买家秀专项优化方案",
  },
};

const competitorDimensions: Array<{
  key: CompetitorDimensionKey;
  title: string;
  description: string;
}> = [
  {
    key: "copy",
    title: "营销文案",
    description: "人群、痛点、卖点、证据话术",
  },
  {
    key: "visual",
    title: "视觉表达",
    description: "构图、色彩、主体和信息密度",
  },
  {
    key: "structure",
    title: "页面框架",
    description: "模块顺序、说服链路和收口方式",
  },
];

function formatFiles(files: File[]) {
  if (!files.length) return "";
  if (files.length === 1) return files[0].name;
  return `${files[0].name} 等 ${files.length} 个文件`;
}

function preserveFolderPaths(files: File[]) {
  return files.map((file) => {
    if (!file.webkitRelativePath) return file;

    return new File([file], file.webkitRelativePath, {
      type: file.type,
      lastModified: file.lastModified,
    });
  });
}

function classifyTargetName(
  name: string,
):
  | "market"
  | "competitor"
  | "detail"
  | "review"
  | "buyer"
  | "unclassified" {
  const normalized = name.normalize("NFKC").replaceAll("\\", "/").toLowerCase();

  if (
    normalized.includes("市场资料") ||
    normalized.includes("行业分析") ||
    normalized.includes("市场分析") ||
    normalized.includes("/market/")
  ) {
    return "market";
  }

  if (
    normalized.includes("竞品资料") ||
    normalized.includes("多竞品") ||
    normalized.includes("竞品分析") ||
    normalized.includes("/competitor/")
  ) {
    return "competitor";
  }

  if (
    normalized.includes("买家秀") ||
    normalized.includes("/buyer/") ||
    normalized.includes("buyer-show")
  ) {
    return "buyer";
  }

  if (
    normalized.includes("详情页") ||
    normalized.includes("竞品详情") ||
    normalized.includes("/detail/") ||
    normalized.includes("product-detail")
  ) {
    return "detail";
  }

  if (
    normalized.includes("评价区") ||
    normalized.includes("评价标签") ||
    normalized.includes("评论区") ||
    normalized.includes("追评") ||
    normalized.includes("问大家") ||
    normalized.includes("商家回复") ||
    normalized.includes("/review/")
  ) {
    return "review";
  }

  return "unclassified";
}

function summarizeFiles(files: File[]) {
  const summary = {
    market: 0,
    competitor: 0,
    detail: 0,
    review: 0,
    buyer: 0,
    unclassified: 0,
    archives: 0,
  };

  files.forEach((file) => {
    if (file.name.toLowerCase().endsWith(".zip")) {
      summary.archives += 1;
      return;
    }

    summary[classifyTargetName(file.name)] += 1;
  });

  return summary;
}

function isZipUpload(file: File) {
  return (
    file.name.toLowerCase().endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

async function inspectCompetitorFiles(files: File[]) {
  const entries: CompetitorUploadEntry[] = [];

  for (const file of files) {
    if (isZipUpload(file)) {
      entries.push(
        ...listZipCompetitorEntries(
          new Uint8Array(await file.arrayBuffer()),
          file.name,
        ),
      );
      continue;
    }

    entries.push(
      createCompetitorEntry({
        id: `upload:${file.name}`,
        path: file.name,
        source: "直接上传",
        size: file.size,
      }),
    );
  }

  return entries;
}

function competitorInspectionMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    ZIP_ENCRYPTED: "ZIP 带有密码，无法识别竞品分组，请解除密码后重新上传。",
    ZIP_ENTRY_LIMIT: "ZIP 内存在超过 15MB 的文件，请压缩或拆分后重试。",
    ZIP_EXPANDED_LIMIT: "ZIP 解压后的总体积超过 60MB，请拆分后重试。",
    ZIP_LIMIT: "ZIP 文件数量过多或使用了 ZIP64，请重新打包后上传。",
    ZIP_INVALID: "ZIP 无法读取，请重新打包后上传。",
  };
  return messages[code] ?? "竞品资料识别失败，请重新选择文件。";
}

export default function Home() {
  const [activeModule, setActiveModule] = useState<ModuleKey>("market");
  const [selectedCompetitorDimensions, setSelectedCompetitorDimensions] =
    useState<CompetitorDimensionKey[]>(["copy", "visual", "structure"]);
  const [ownFiles, setOwnFiles] = useState<File[]>([]);
  const [targetFiles, setTargetFiles] = useState<File[]>([]);
  const [competitorEntries, setCompetitorEntries] = useState<
    CompetitorUploadEntry[]
  >([]);
  const [competitorAssignments, setCompetitorAssignments] = useState<
    Record<string, string>
  >({});
  const [additionalCompetitorNames, setAdditionalCompetitorNames] = useState<
    string[]
  >([]);
  const [newCompetitorName, setNewCompetitorName] = useState("");
  const [isInspectingCompetitors, setIsInspectingCompetitors] = useState(false);
  const [competitorInspectionError, setCompetitorInspectionError] =
    useState("");
  const [notice, setNotice] = useState("");
  const [analysisResult, setAnalysisResult] = useState("");
  const [resultView, setResultView] = useState<ResultView>("report");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const ownInputRef = useRef<HTMLInputElement>(null);
  const ownFolderInputRef = useRef<HTMLInputElement>(null);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const targetFolderInputRef = useRef<HTMLInputElement>(null);
  const analysisSession = useRef(createAsyncSessionGuard<ModuleKey>());

  useEffect(() => () => analysisSession.current.cancel(), []);

  const activeCopy = useMemo(
    () => analysisCopy[activeModule],
    [activeModule],
  );
  const recognitionSummary = useMemo(
    () => summarizeFiles(targetFiles),
    [targetFiles],
  );
  const competitorRecognition = useMemo(
    () =>
      buildCompetitorRecognition(
        competitorEntries,
        competitorAssignments,
        additionalCompetitorNames,
      ),
    [competitorEntries, competitorAssignments, additionalCompetitorNames],
  );
  const selectedCompetitorDimensionTitles = useMemo(
    () =>
      competitorDimensions
        .filter((item) => selectedCompetitorDimensions.includes(item.key))
        .map((item) => item.title),
    [selectedCompetitorDimensions],
  );

  function switchModule(key: ModuleKey) {
    analysisSession.current.cancel();
    setActiveModule(key);
    setOwnFiles([]);
    setTargetFiles([]);
    setCompetitorEntries([]);
    setCompetitorAssignments({});
    setAdditionalCompetitorNames([]);
    setNewCompetitorName("");
    setIsInspectingCompetitors(false);
    setCompetitorInspectionError("");
    setAnalysisResult("");
    setResultView("report");
    setIsAnalyzing(false);
    setNotice("");
  }

  function toggleCompetitorDimension(key: CompetitorDimensionKey) {
    setSelectedCompetitorDimensions((current) => {
      if (current.includes(key)) {
        if (current.length === 1) {
          setNotice("竞品分析至少保留一个分析维度。");
          return current;
        }
        setNotice("");
        return current.filter((item) => item !== key);
      }

      setNotice("");
      return [...current, key];
    });
    setAnalysisResult("");
  }

  async function startAnalysis() {
    if (activeModule === "review") return;

    if (!targetFiles.length) {
      setNotice("请先上传需要分析的资料。");
      setAnalysisResult("");
      return;
    }

    if (activeModule === "competitor") {
      if (isInspectingCompetitors) {
        setNotice("正在识别竞品资料，请稍候。");
        return;
      }
      if (competitorInspectionError) {
        setNotice(competitorInspectionError);
        return;
      }
      if (!competitorRecognition.groups.length) {
        setNotice("尚未识别出竞品，请按竞品建立文件夹或手动添加竞品分组。");
        return;
      }
      if (competitorRecognition.unclassified.length) {
        setNotice(
          `还有 ${competitorRecognition.unclassified.length} 个文件待归类，请先选择所属竞品。`,
        );
        return;
      }
    }

    const selectedFiles = [...ownFiles, ...targetFiles];
    const oversizedFile = selectedFiles.find(
      (file) => file.size > MAX_UPLOAD_FILE_BYTES,
    );
    if (oversizedFile) {
      setNotice(`文件「${oversizedFile.name}」超过 50MB，请压缩或拆分后上传。`);
      setAnalysisResult("");
      return;
    }

    const totalUploadBytes = selectedFiles.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    if (totalUploadBytes > MAX_UPLOAD_TOTAL_BYTES) {
      setNotice("本次上传总大小超过 80MB，请拆分文件包后重试。");
      setAnalysisResult("");
      return;
    }
    if (totalUploadBytes > MAX_HOSTED_DIRECT_UPLOAD_BYTES) {
      setNotice(
        "当前线上版本单次直传上限约为 850KB，请压缩、拆分或精简文件后重试。",
      );
      setAnalysisResult("");
      return;
    }

    const run = analysisSession.current.begin(activeModule);
    setNotice("");
    setAnalysisResult("");
    setIsAnalyzing(true);

    try {
      const formData = new FormData();
      formData.append("module", activeModule);
      if (activeModule === "competitor") {
        formData.append(
          "competitorDimensions",
          selectedCompetitorDimensions.join(","),
        );
        formData.append(
          "competitorManifest",
          JSON.stringify(buildCompetitorManifest(competitorRecognition)),
        );
      }
      ownFiles.forEach((file) =>
        formData.append("ownFiles", file, file.name),
      );
      targetFiles.forEach((file) =>
        formData.append("targetFiles", file, file.name),
      );

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
        signal: run.signal,
      });
      if (!analysisSession.current.isCurrent(run)) return;
      const responseText = await response.text();
      if (!analysisSession.current.isCurrent(run)) return;
      let payload: {
        result?: string;
        error?: string;
      } = {};
      try {
        payload = JSON.parse(responseText) as {
          result?: string;
          error?: string;
        };
      } catch {
        payload = {};
      }

      if (!response.ok || !payload.result) {
        if (!analysisSession.current.isCurrent(run)) return;
        setNotice(
          payload.error ||
            (response.status === 413
              ? "资料超过当前托管层的单次请求限制，请拆分后重新上传。"
              : "分析失败，请稍后重试。"),
        );
        return;
      }

      if (!analysisSession.current.isCurrent(run)) return;
      setNotice("");
      setAnalysisResult(payload.result);
      setResultView("report");
      window.setTimeout(() => {
        if (!analysisSession.current.isCurrent(run)) return;
        document
          .getElementById("result")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 40);
    } catch (error) {
      if (!analysisSession.current.isCurrent(run) || isAbortError(error)) return;
      setNotice("无法连接分析服务，请稍后重试。");
    } finally {
      if (analysisSession.current.isCurrent(run)) setIsAnalyzing(false);
    }
  }

  function handleOwnFiles(files: File[]) {
    setOwnFiles(files);
    setAnalysisResult("");
    setNotice("");
  }

  async function handleTargetFiles(files: File[]) {
    setTargetFiles(files);
    setAnalysisResult("");
    setNotice("");
    setCompetitorAssignments({});
    setAdditionalCompetitorNames([]);
    setNewCompetitorName("");
    setCompetitorInspectionError("");

    if (activeModule !== "competitor" || !files.length) {
      setCompetitorEntries([]);
      setIsInspectingCompetitors(false);
      return;
    }

    setIsInspectingCompetitors(true);
    try {
      setCompetitorEntries(await inspectCompetitorFiles(files));
    } catch (error) {
      setCompetitorEntries([]);
      setCompetitorInspectionError(competitorInspectionMessage(error));
    } finally {
      setIsInspectingCompetitors(false);
    }
  }

  function assignCompetitor(entryId: string, groupName: string) {
    setCompetitorAssignments((current) => ({
      ...current,
      [entryId]: groupName,
    }));
    setAnalysisResult("");
    setNotice("");
  }

  function addCompetitorGroup() {
    const groupName = newCompetitorName.trim().slice(0, 40);
    if (!groupName) {
      setNotice("请先填写竞品名称。");
      return;
    }
    if (
      competitorRecognition.groups.some((group) => group.name === groupName)
    ) {
      setNotice("这个竞品分组已经存在。");
      return;
    }

    setAdditionalCompetitorNames((current) => [...current, groupName]);
    setNewCompetitorName("");
    setNotice("");
  }

  function scrollToResult() {
    window.setTimeout(() => {
      document
        .getElementById("result")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  }

  async function copyResult() {
    if (!analysisResult) return;

    try {
      await navigator.clipboard.writeText(analysisResult);
      setNotice("分析结果已复制。");
    } catch {
      setNotice("复制失败，请在结果框中手动选择复制。");
    }
  }

  function downloadResult() {
    if (!analysisResult) return;

    const blob = new Blob([analysisResult], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeCopy.resultTitle}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadExcelResult() {
    if (!analysisResult) return;

    try {
      const workbook = buildExcelWorkbook(
        analysisResult,
        activeCopy.resultTitle,
      );
      const workbookBuffer = workbook.buffer.slice(
        workbook.byteOffset,
        workbook.byteOffset + workbook.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([workbookBuffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${activeCopy.resultTitle}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Excel 表格已导出。");
    } catch {
      setNotice("未识别到可导出的表格，请切回表格格式后重试。");
    }
  }

  const hasRecognitionFiles = targetFiles.length > 0;
  const standardAccept =
    "image/*,.zip,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json,.html,.xml,.ppt,.pptx,.rtf,.odt";
  const uploadAccept = standardAccept;
  const uploadSectionTitle =
    activeModule === "market"
      ? "上传市场资料"
      : activeModule === "competitor"
        ? "上传多组竞品资料"
        : activeModule === "complete"
          ? "上传全链路资料"
          : "上传双方资料";
  const targetIcon =
    activeModule === "market"
      ? "市"
      : activeModule === "competitor"
        ? "竞"
        : activeModule === "detail"
          ? "详"
          : activeModule === "review"
            ? "评"
            : activeModule === "buyer"
              ? "秀"
              : "链";

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="产品分析助手首页">
          <span className="brand-mark">策</span>
          <span>产品分析助手</span>
        </a>
        <div className="header-actions">
          <span className="header-note">固定两张表 · 无需二次整理</span>
          <a
            className="guide-link"
            href="/产品分析助手使用说明.docx"
            download
          >
            下载使用说明
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">
          <span className="eyebrow-dot" />
          运营分析工作台
        </div>
        <h1>
          先看市场，再拆竞品
          <br />
          <span>把分析直接变成运营表</span>
        </h1>
        <p>
          从市场格局中筛出最值得对标的竞品，再按营销文案、视觉表达和页面框架拆解，结果直接生成可编辑、可导出的执行表。
        </p>
      </section>

      <section className="workspace" aria-label="商品分析工作区">
        <div className="section-heading">
          <div>
            <span className="section-number">STEP 1</span>
            <h2>你想分析什么？</h2>
          </div>
          <span className="section-hint">单选</span>
        </div>

        <div className="primary-flow" aria-label="核心分析流程">
          {featuredModules.map((item) => {
            const selected = activeModule === item.key;
            return (
              <button
                className={`module-card module-card-featured ${
                  selected ? "is-active" : ""
                }`}
                key={item.key}
                type="button"
                onClick={() => switchModule(item.key)}
                aria-pressed={selected}
              >
                <span className="module-order">{item.order}</span>
                <span className="flow-badge">{item.flowLabel}</span>
                <span className="module-check">{selected ? "✓" : ""}</span>
                <strong>{item.title}</strong>
                <span className="module-description">{item.description}</span>
              </button>
            );
          })}
        </div>

        <div className="module-grid">
          {specialistModules.map((item) => {
            const selected = activeModule === item.key;
            return (
              <button
                className={`module-card ${selected ? "is-active" : ""}`}
                key={item.key}
                type="button"
                onClick={() => switchModule(item.key)}
                aria-pressed={selected}
              >
                <span className="module-order">{item.order}</span>
                <span className="module-check">{selected ? "✓" : ""}</span>
                <strong>{item.title}</strong>
                <span className="module-description">{item.description}</span>
              </button>
            );
          })}
        </div>

        {activeModule === "review" && <NeigongWorkspace />}
        {activeModule !== "review" && (
          <>
            <div className="divider" />

            <div className="section-heading">
              <div>
                <span className="section-number">STEP 2</span>
                <h2>{uploadSectionTitle}</h2>
              </div>
              <span className="section-hint">
                支持文件、ZIP 压缩包和整个文件夹
              </span>
            </div>

        {activeModule === "competitor" && (
          <>
            <section
              className="competitor-upload-guide"
              aria-label="多竞品资料整理方式"
            >
              <div className="competitor-guide-copy">
                <span>MULTI-COMPETITOR</span>
                <strong>一次上传，横向识别多个竞品</strong>
                <p>
                  每个竞品单独建一个文件夹。上传后，系统会先按竞品分组展示，
                  确认无误后再开始分析。
                </p>
              </div>
              <div className="competitor-folder-example">
                <span>推荐文件夹结构</span>
                <code>竞品资料／</code>
                <code>├─ 竞品 A／主图、文案</code>
                <code>├─ 竞品 B／详情页</code>
                <code>└─ 竞品 C／评价区</code>
              </div>
              <div className="competitor-guide-limit">
                <strong>2–5</strong>
                <span>个竞品更适合横向比较</span>
              </div>
            </section>

            <fieldset className="dimension-picker">
              <legend>选择本次竞品分析维度</legend>
              <div className="dimension-grid">
                {competitorDimensions.map((item) => {
                  const selected = selectedCompetitorDimensions.includes(
                    item.key,
                  );
                  return (
                    <button
                      className={selected ? "is-selected" : ""}
                      key={item.key}
                      type="button"
                      onClick={() => toggleCompetitorDimension(item.key)}
                      aria-pressed={selected}
                    >
                      <span className="dimension-check">
                        {selected ? "✓" : ""}
                      </span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </>
        )}

        <div className="upload-grid">
          <input
            ref={ownInputRef}
            className="sr-only"
            type="file"
            multiple
            accept={uploadAccept}
            onChange={(event) =>
              handleOwnFiles(Array.from(event.target.files ?? []))
            }
          />
          <input
            ref={ownFolderInputRef}
            className="sr-only"
            type="file"
            multiple
            {...({
              webkitdirectory: "",
              directory: "",
            } as InputHTMLAttributes<HTMLInputElement>)}
            onChange={(event) =>
              handleOwnFiles(
                preserveFolderPaths(Array.from(event.target.files ?? [])),
              )
            }
          />
          <div
            className={`upload-group ${ownFiles.length ? "has-file" : ""}`}
          >
            <div className="upload-card">
              <span className="upload-icon">我</span>
              <span className="upload-copy">
                <span className="upload-title-row">
                  <strong>我方产品资料（可选）</strong>
                  <span className="knowledge-badge">
                    已内置基础知识
                  </span>
                </span>
                <small>
                  {ownFiles.length
                    ? formatFiles(ownFiles)
                    : "可上传最新一页纸、检测材料或成品资料包进行补充"}
                </small>
              </span>
            </div>
            <div className="upload-choices">
              <button type="button" onClick={() => ownInputRef.current?.click()}>
                选择文件／ZIP
              </button>
              <button
                type="button"
                onClick={() => ownFolderInputRef.current?.click()}
              >
                选择文件夹
              </button>
            </div>
          </div>

          <input
            ref={targetInputRef}
            className="sr-only"
            type="file"
            multiple
            accept={uploadAccept}
            onChange={(event) => {
              void handleTargetFiles(Array.from(event.target.files ?? []));
            }}
          />
          <input
            ref={targetFolderInputRef}
            className="sr-only"
            type="file"
            multiple
            {...({
              webkitdirectory: "",
              directory: "",
            } as InputHTMLAttributes<HTMLInputElement>)}
            onChange={(event) => {
              void handleTargetFiles(
                preserveFolderPaths(Array.from(event.target.files ?? [])),
              );
            }}
          />
          <div
            className={`upload-group ${targetFiles.length ? "has-file" : ""}`}
          >
            <div className="upload-card">
              <span className="upload-icon upload-icon-target">
                {targetIcon}
              </span>
              <span className="upload-copy">
                <strong>{activeCopy.uploadTitle}</strong>
                <small>
                  {targetFiles.length
                    ? formatFiles(targetFiles)
                    : `${activeCopy.uploadDescription}，或上传完整文件包`}
                </small>
              </span>
            </div>
            <div className="upload-choices">
              <button
                type="button"
                onClick={() => targetInputRef.current?.click()}
              >
                选择文件／ZIP
              </button>
              <button
                type="button"
                onClick={() => targetFolderInputRef.current?.click()}
              >
                选择文件夹
              </button>
            </div>
          </div>
        </div>

        {hasRecognitionFiles && (
          <>
            <div className="divider divider-compact" />
            <div className="section-heading recognition-heading">
              <div>
                <span className="section-number">STEP 3</span>
                <h2>资料识别结果</h2>
              </div>
              <span className="section-hint">
                {activeModule === "complete"
                  ? "按文件夹和文件名识别"
                  : "专项资料已就绪"}
              </span>
            </div>

            {activeModule === "competitor" ? (
              <section
                className="competitor-recognition"
                aria-label="竞品资料分组结果"
              >
                <div className="competitor-recognition-summary">
                  <div>
                    <span>本次识别</span>
                    <strong>
                      {competitorRecognition.groups.length} 个竞品
                    </strong>
                    <small>
                      共 {competitorRecognition.totalEntries} 个可分析文件
                    </small>
                  </div>
                  <span
                    className={`competitor-recognition-status ${
                      competitorInspectionError ||
                      competitorRecognition.unclassified.length
                        ? "needs-attention"
                        : ""
                    }`}
                  >
                    {isInspectingCompetitors
                      ? "正在识别"
                      : competitorInspectionError
                        ? "识别失败"
                        : competitorRecognition.unclassified.length
                          ? `${competitorRecognition.unclassified.length} 个待归类`
                          : competitorRecognition.groups.length < 2
                            ? "建议再添加竞品"
                            : "可以开始横向分析"}
                  </span>
                </div>

                {isInspectingCompetitors && (
                  <div className="competitor-inspection-loading" role="status">
                    <span aria-hidden="true" />
                    正在读取文件夹和 ZIP 内的竞品结构……
                  </div>
                )}

                {competitorInspectionError && (
                  <p className="competitor-inspection-error" role="alert">
                    {competitorInspectionError}
                  </p>
                )}

                {!isInspectingCompetitors &&
                  competitorRecognition.groups.length > 0 && (
                    <div className="competitor-group-grid">
                      {competitorRecognition.groups.map((group, index) => (
                        <article className="competitor-group-card" key={group.name}>
                          <header>
                            <span className="competitor-group-index">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <div>
                              <strong>{group.name}</strong>
                              <small>{group.entries.length} 个文件</small>
                            </div>
                            <span className="competitor-group-ready">已归类</span>
                          </header>
                          <div className="competitor-file-metrics">
                            {group.imageCount > 0 && (
                              <span>图片 {group.imageCount}</span>
                            )}
                            {group.documentCount > 0 && (
                              <span>文档 {group.documentCount}</span>
                            )}
                            {group.spreadsheetCount > 0 && (
                              <span>表格 {group.spreadsheetCount}</span>
                            )}
                            {group.otherCount > 0 && (
                              <span>其他 {group.otherCount}</span>
                            )}
                            {!group.entries.length && <span>等待分配文件</span>}
                          </div>
                          {group.entries.length > 0 && (
                            <details>
                              <summary>查看并调整文件归属</summary>
                              <div className="competitor-file-list">
                                {group.entries.map((entry) => (
                                  <label key={entry.id}>
                                    <span title={entry.path}>{entry.path}</span>
                                    <select
                                      aria-label={`调整 ${entry.path} 的竞品归属`}
                                      value={
                                        competitorAssignments[entry.id] ??
                                        entry.detectedGroup ??
                                        ""
                                      }
                                      onChange={(event) =>
                                        assignCompetitor(
                                          entry.id,
                                          event.target.value,
                                        )
                                      }
                                    >
                                      {competitorRecognition.groups.map(
                                        (optionGroup) => (
                                          <option
                                            key={optionGroup.name}
                                            value={optionGroup.name}
                                          >
                                            {optionGroup.name}
                                          </option>
                                        ),
                                      )}
                                    </select>
                                  </label>
                                ))}
                              </div>
                            </details>
                          )}
                        </article>
                      ))}
                    </div>
                  )}

                {!isInspectingCompetitors &&
                  competitorRecognition.unclassified.length > 0 && (
                    <section className="competitor-unclassified">
                      <div>
                        <strong>待归类资料</strong>
                        <span>
                          这些文件名看不出所属竞品，请手动选择后再分析。
                        </span>
                      </div>
                      <div className="competitor-unclassified-list">
                        {competitorRecognition.unclassified.map((entry) => (
                          <label key={entry.id}>
                            <span title={entry.path}>{entry.path}</span>
                            <select
                              aria-label={`选择 ${entry.path} 的竞品归属`}
                              value={competitorAssignments[entry.id] ?? ""}
                              onChange={(event) =>
                                assignCompetitor(entry.id, event.target.value)
                              }
                            >
                              <option value="">选择所属竞品</option>
                              {competitorRecognition.groups.map((group) => (
                                <option key={group.name} value={group.name}>
                                  {group.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                    </section>
                  )}

                {!isInspectingCompetitors && !competitorInspectionError && (
                  <div className="competitor-add-group">
                    <label htmlFor="new-competitor-name">没有识别到名称？</label>
                    <input
                      id="new-competitor-name"
                      type="text"
                      maxLength={40}
                      value={newCompetitorName}
                      placeholder="输入竞品名称"
                      onChange={(event) =>
                        setNewCompetitorName(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCompetitorGroup();
                        }
                      }}
                    />
                    <button type="button" onClick={addCompetitorGroup}>
                      添加竞品
                    </button>
                  </div>
                )}
              </section>
            ) : activeModule === "complete" ? (
              <div className="recognition-list full-chain-recognition">
                <div>
                  <span>市场资料</span>
                  <strong>{recognitionSummary.market} 个文件</strong>
                </div>
                <div>
                  <span>竞品资料</span>
                  <strong>{recognitionSummary.competitor} 个文件</strong>
                </div>
                <div>
                  <span>详情页</span>
                  <strong>{recognitionSummary.detail} 个文件</strong>
                </div>
                <div>
                  <span>评价区</span>
                  <strong>{recognitionSummary.review} 个文件</strong>
                </div>
                <div>
                  <span>买家秀</span>
                  <strong>{recognitionSummary.buyer} 个文件</strong>
                </div>
                <div
                  className={
                    recognitionSummary.unclassified ? "needs-attention" : ""
                  }
                >
                  <span>暂未识别</span>
                  <strong>{recognitionSummary.unclassified} 个文件</strong>
                </div>
                {recognitionSummary.archives > 0 && (
                  <p>
                    已选择 {recognitionSummary.archives} 个 ZIP，包内文件会在开始分析后自动解压并分类。
                  </p>
                )}
              </div>
            ) : (
              <div className="recognition-list recognition-list-single">
                <div>
                  <span>{activeCopy.uploadTitle}</span>
                  <strong>{targetFiles.length} 个文件／文件包</strong>
                </div>
              </div>
            )}
          </>
        )}

            <div className="run-area">
          {activeModule === "competitor" && targetFiles.length > 0 && (
            <div className="competitor-run-summary">
              <span>本次将横向对比</span>
              <strong>{competitorRecognition.groups.length} 个竞品</strong>
              <div>
                {selectedCompetitorDimensionTitles.map((title) => (
                  <span key={title}>{title}</span>
                ))}
              </div>
            </div>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={isAnalyzing ? scrollToResult : startAnalysis}
            disabled={isAnalyzing}
          >
            {isAnalyzing ? (
              <>
                <span className="button-spinner" aria-hidden="true" />
                {activeModule === "complete"
                  ? "正在完成五项分析并汇总"
                  : activeModule === "competitor"
                    ? "正在横向分析多个竞品"
                    : "正在读取资料并分析"}
              </>
            ) : (
              <>
                {activeModule === "complete"
                  ? "开始生成全链路分析方案"
                  : activeModule === "competitor"
                    ? "开始生成多竞品对比方案"
                  : "开始生成分析方案"}
                <span aria-hidden="true">→</span>
              </>
            )}
          </button>
          <p>
            后台自动匹配提示词与产品知识，文件仅用于本次分析
          </p>
          {notice && (
            <p className="form-notice" role="alert">
              {notice}
            </p>
          )}
            </div>
          </>
        )}
      </section>

      {activeModule !== "review" && analysisResult && (
        <section className="result-panel" id="result" aria-live="polite">
          <div className="result-topline">
            <div>
              <span className="result-label">分析结果</span>
              <h2>{activeCopy.resultTitle}</h2>
            </div>
            <div className="result-actions">
              <span className="matched-badge">已匹配内置知识库</span>
              <button type="button" onClick={copyResult}>
                复制结果
              </button>
              <button type="button" onClick={downloadExcelResult}>
                导出 Excel
              </button>
              <button type="button" onClick={downloadResult}>
                下载 Markdown
              </button>
            </div>
          </div>

          <div className="result-view-switch" aria-label="分析结果查看方式">
            <button
              className={resultView === "report" ? "is-active" : ""}
              type="button"
              onClick={() => setResultView("report")}
              aria-pressed={resultView === "report"}
            >
              表格视图
            </button>
            <button
              className={resultView === "edit" ? "is-active" : ""}
              type="button"
              onClick={() => setResultView("edit")}
              aria-pressed={resultView === "edit"}
            >
              编辑原文
            </button>
          </div>

          <div className="analysis-output">
            {resultView === "report" ? (
              <>
                <div className="report-hint">
                  已按分析表自动排版，可直接导出 Excel；表格较宽时可左右滑动查看
                </div>
                <article className="report-view">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      table: ({ children }) => (
                        <div className="report-table-scroll">
                          <table>{children}</table>
                        </div>
                      ),
                    }}
                  >
                    {analysisResult}
                  </ReactMarkdown>
                </article>
              </>
            ) : (
              <>
                <label htmlFor="analysis-editor">修改后可切回表格视图</label>
                <textarea
                  id="analysis-editor"
                  className="analysis-editor"
                  value={analysisResult}
                  onChange={(event) => setAnalysisResult(event.target.value)}
                  spellCheck={false}
                />
              </>
            )}
          </div>
        </section>
      )}

      <footer>
        <span>产品分析助手</span>
        <span>证据定位、对比判断和优化方案在后台完成</span>
      </footer>
    </main>
  );
}
