"use client";

import type { ProductPackFiles } from "@/lib/neigong/excel-parser";
import type { ProductRole } from "@/lib/neigong/types";

export type ProductPackDraft = ProductPackFiles;

export type ProductPackCardProps = {
  productId: string;
  role: ProductRole;
  name: string;
  files: ProductPackFiles;
  onChange(next: ProductPackDraft): void;
  onRemove?: () => void;
};

type FileKey = "defaultReviewFile" | "recentReviewFile" | "questionFile" | "screenshotFile";

type FileSlotProps = {
  inputId: string;
  label: string;
  hint: string;
  accept: string;
  file?: File;
  onSelect(file?: File): void;
};

function FileSlot({ inputId, label, hint, accept, file, onSelect }: FileSlotProps) {
  return (
    <label className={`neigong-file-slot${file ? " neigong-file-slot-ready" : ""}`} htmlFor={inputId}>
      <span className="neigong-file-slot-label">{label}</span>
      <span className="neigong-file-slot-name">{file?.name ?? "选择文件"}</span>
      <span className="neigong-file-slot-hint">{file ? "已选择，可重新上传" : hint}</span>
      <input
        id={inputId}
        className="neigong-file-input"
        type="file"
        accept={accept}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          onSelect(file);
        }}
      />
    </label>
  );
}

export function ProductPackCard({
  productId,
  role,
  name,
  files,
  onChange,
  onRemove,
}: ProductPackCardProps) {
  const updateName = (nextName: string) => {
    onChange({
      ...files,
      product: { productId, role, name: nextName },
    });
  };

  const updateFile = (key: FileKey, file?: File) => {
    onChange({
      ...files,
      product: { productId, role, name },
      [key]: file,
    });
  };

  return (
    <article className="neigong-product-card">
      <div className="neigong-product-card-head">
        <div>
          <span className="neigong-role-badge">{role === "self" ? "我方产品" : "竞品"}</span>
          <label className="neigong-product-name-label" htmlFor={`${productId}-name`}>
            产品名称
          </label>
          <input
            id={`${productId}-name`}
            className="neigong-product-name"
            type="text"
            value={name}
            placeholder={role === "self" ? "填写我方产品名称" : "填写竞品名称"}
            onChange={(event) => updateName(event.currentTarget.value)}
          />
        </div>
        {role === "competitor" && onRemove ? (
          <button className="neigong-text-button neigong-danger-button" type="button" onClick={onRemove}>
            删除竞品
          </button>
        ) : null}
      </div>

      <div className="neigong-file-slots">
        <FileSlot
          inputId={`${productId}-default-reviews`}
          label="默认排序评价 Excel"
          hint="上传默认排序导出的评价文件"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={files.defaultReviewFile}
          onSelect={(file) => updateFile("defaultReviewFile", file)}
        />
        <FileSlot
          inputId={`${productId}-recent-reviews`}
          label="时间排序评价 Excel"
          hint="上传时间排序导出的评价文件"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={files.recentReviewFile}
          onSelect={(file) => updateFile("recentReviewFile", file)}
        />
        <FileSlot
          inputId={`${productId}-questions`}
          label="问大家 Excel"
          hint="首个工作表作为问大家数据"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={files.questionFile}
          onSelect={(file) => updateFile("questionFile", file)}
        />
        <FileSlot
          inputId={`${productId}-screenshot`}
          label="评价页截图"
          hint="PNG、JPEG 或 WebP"
          accept="image/png,image/jpeg,image/webp"
          file={files.screenshotFile}
          onSelect={(file) => updateFile("screenshotFile", file)}
        />
      </div>
    </article>
  );
}
