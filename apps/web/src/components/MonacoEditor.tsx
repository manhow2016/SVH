import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
// 内置语言高亮（Monarch tokenizer，无需额外 worker）
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
// JSON 语言服务（含 worker）
import "monaco-editor/esm/vs/language/json/monaco.contribution";
// 离线 Worker（vite ?worker 引入，不依赖 CDN）
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

// 配置 Monaco 使用本地 worker
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") {
      return new JsonWorker();
    }
    return new EditorWorker();
  },
};

export interface MonacoEditorProps {
  value: string;
  /** markdown | json | yaml | javascript | plaintext ... */
  language?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

/** 基于 Monaco 的轻量编辑器组件（离线打包） */
export function MonacoEditor({
  value,
  language = "markdown",
  readOnly = false,
  onChange,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastValueRef = useRef(value);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const editor = monaco.editor.create(container, {
      value,
      language,
      readOnly,
      theme: "vs", // 浅色主题
      fontSize: 12.5,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      lineNumbers: "on",
      wordWrap: "on",
      padding: { top: 8, bottom: 8 },
      renderLineHighlight: "gutter",
    });
    editorRef.current = editor;
    lastValueRef.current = value;

    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });

    return () => {
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // 仅创建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value/language 变化同步（避免打字时回写）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value !== lastValueRef.current && value !== editor.getValue()) {
      editor.setValue(value);
      lastValueRef.current = value;
    }
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [value, language]);

  // readOnly 切换
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
