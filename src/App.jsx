import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import MarkdownIt from 'markdown-it';
import {
  FileText, Download, FolderOpen, Save, Edit3, Eye, Columns,
  List, X, FileDown, RotateCcw,
} from 'lucide-react';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  Table, TableRow, TableCell, WidthType,
} from 'docx';
import { saveAs } from 'file-saver';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import './index.css';

const md = new MarkdownIt({ html: false, breaks: true, linkify: true });
const ZH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

// ── Bullet Widget ─────────────────────────────────────────
// 用真实 DOM 节点替换 `-` / `*`，彻底隐藏原始符号
class BulletWidget extends WidgetType {
  constructor(char) { super(); this.char = char; }
  eq(other) { return other.char === this.char; }
  toDOM() {
    const span = document.createElement('span');
    span.textContent = this.char;
    span.className = 'cm-bullet-widget';
    return span;
  }
  ignoreEvent() { return false; }
}

// ── Live Preview Extension ────────────────────────────────
// 修复核心：用 Decoration.replace({}) 代替 Decoration.mark({ class: 'cm-md-hidden' })
// replace 会从渲染层真正抹掉字符，mark 只加 CSS 类，fontSize:0 不可靠

const HEADING_PREFIXES = ['###### ', '##### ', '#### ', '### ', '## ', '# '];
const HEADING_CLASS = {
  '# ': 'cm-h1', '## ': 'cm-h2', '### ': 'cm-h3',
  '#### ': 'cm-h4', '##### ': 'cm-h5', '###### ': 'cm-h6',
};

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      // 收集本行所有装饰，排序后统一添加，避免乱序报错
      const decs = [];

      if (line.number !== cursorLine) {

        // ── 标题 ──────────────────────────────────────────
        let isHeading = false;
        for (const prefix of HEADING_PREFIXES) {
          if (text.startsWith(prefix)) {
            const cls = HEADING_CLASS[prefix];
            // 用 replace 真正抹掉 "# " / "## " 等前缀
            decs.push({ from: line.from, to: line.from + prefix.length, deco: Decoration.replace({}) });
            if (line.to > line.from + prefix.length) {
              decs.push({ from: line.from + prefix.length, to: line.to, deco: Decoration.mark({ class: cls }) });
            }
            isHeading = true;
            break;
          }
        }

        if (!isHeading) {

          // ── 分割线 ────────────────────────────────────
          if (/^-{3,}\s*$/.test(text)) {
            decs.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: 'cm-hr' }) });
          }

          // ── 引用块 > ──────────────────────────────────
          else if (text.startsWith('> ')) {
            decs.push({ from: line.from, to: line.from + 2, deco: Decoration.replace({}) });
            if (line.to > line.from + 2) {
              decs.push({ from: line.from + 2, to: line.to, deco: Decoration.mark({ class: 'cm-blockquote' }) });
            }
          }

          else {
            // ── 无序列表：用 BulletWidget 替换 "- " / "* " ──
            const listMatch = text.match(/^(\s*)([-*]) /);
            if (listMatch) {
              const indent = listMatch[1].length;
              const bulletStart = line.from + indent;
              // 4空格=深1，8空格=深2，以此类推
              const depth = Math.min(Math.floor(indent / 4), 2);
              const bulletChar = ['•', '◦', '▪'][depth];
              // replace '- '（2个字符）为 bullet widget
              decs.push({
                from: bulletStart,
                to: bulletStart + 2,
                deco: Decoration.replace({ widget: new BulletWidget(bulletChar) }),
              });
            }

            // ── 粗体 **text** ── replace 抹掉 ** 标记 ───
            const boldRe = /\*\*(.+?)\*\*/g;
            let m;
            while ((m = boldRe.exec(text)) !== null) {
              const s = line.from + m.index;
              decs.push({ from: s,             to: s + 2,                      deco: Decoration.replace({}) });
              decs.push({ from: s + 2,          to: s + 2 + m[1].length,        deco: Decoration.mark({ class: 'cm-bold' }) });
              decs.push({ from: s + 2 + m[1].length, to: s + m[0].length,      deco: Decoration.replace({}) });
            }

            // ── 斜体 *text*（排除 **）── replace 抹掉 * ──
            const italicRe = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;
            while ((m = italicRe.exec(text)) !== null) {
              const s = line.from + m.index;
              decs.push({ from: s,         to: s + 1,               deco: Decoration.replace({}) });
              decs.push({ from: s + 1,     to: s + 1 + m[1].length, deco: Decoration.mark({ class: 'cm-italic' }) });
              decs.push({ from: s + 1 + m[1].length, to: s + m[0].length, deco: Decoration.replace({}) });
            }

            // ── 行内代码 `code` ── replace 抹掉反引号 ───
            const codeRe = /`([^`]+)`/g;
            while ((m = codeRe.exec(text)) !== null) {
              const s = line.from + m.index;
              decs.push({ from: s,         to: s + 1,               deco: Decoration.replace({}) });
              decs.push({ from: s + 1,     to: s + 1 + m[1].length, deco: Decoration.mark({ class: 'cm-inline-code' }) });
              decs.push({ from: s + 1 + m[1].length, to: s + m[0].length, deco: Decoration.replace({}) });
            }
          }
        }

        // 按起始位置排序，确保 RangeSetBuilder 严格升序
        decs.sort((a, b) => a.from !== b.from ? a.from - b.from : a.to - b.to);

        // 过滤重叠区间，逐一添加到 builder
        let lastTo = line.from - 1;
        for (const d of decs) {
          if (d.from >= lastTo && d.to > d.from) {
            builder.add(d.from, d.to, d.deco);
            lastTo = d.to;
          }
        }
      }

      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const livePreviewExt = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged)
        this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

// ── 所见即所得主题（Obsidian 风格：文档感，无行号）────────
const liveTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': {
    fontFamily: '"仿宋_GB2312","仿宋","FangSong",serif',
    fontSize: '16px',
    lineHeight: '2',
    padding: '20px 0',
    overflowX: 'hidden',
  },
  '.cm-content': {
    padding: '32px 80px',
    caretColor: '#185FA5',
    maxWidth: '860px',
    margin: '0 auto',
  },
  '.cm-cursor': { borderLeftColor: '#185FA5', borderLeftWidth: '2px' },
  '.cm-selectionBackground, .cm-focused .cm-selectionBackground': { backgroundColor: '#cce0f5 !important' },
  // 不高亮当前行，保持文档感
  '.cm-activeLine': { backgroundColor: 'transparent' },
  // 隐藏行号槽
  '.cm-gutters': { display: 'none' },

  // 标题（匹配 .prose 预览的字体/大小）
  '.cm-h1': {
    fontFamily: '"方正小标宋简体","华文中宋","SimSun",serif',
    fontSize: '22px', fontWeight: 'bold', color: '#111',
  },
  '.cm-h2': {
    fontFamily: '"SimHei","黑体",sans-serif',
    fontSize: '18px', fontWeight: 'normal', color: '#1a1a1a',
  },
  '.cm-h3': {
    fontFamily: '"KaiTi","楷体","楷体_GB2312",serif',
    fontSize: '16px', fontWeight: 'normal', color: '#222',
  },
  '.cm-h4': {
    fontFamily: '"仿宋_GB2312","仿宋","FangSong",serif',
    fontSize: '15px', fontWeight: 'bold', color: '#333',
  },
  '.cm-h5, .cm-h6': { fontSize: '14px', color: '#444', fontWeight: 'bold' },

  // 行内样式
  '.cm-bold': { fontWeight: 'bold' },
  '.cm-italic': { fontStyle: 'italic' },
  '.cm-inline-code': {
    fontFamily: '"Consolas","Courier New",monospace',
    fontSize: '13px',
    background: '#f0f0ef',
    padding: '1px 4px',
    borderRadius: '3px',
    color: '#c0392b',
  },
  // BulletWidget 的样式
  '.cm-bullet-widget': {
    color: '#185FA5',
    fontWeight: 'bold',
    marginRight: '6px',
    fontFamily: 'sans-serif',
  },
  '.cm-blockquote': { color: '#666', fontStyle: 'italic', borderLeft: '3px solid #ddd', paddingLeft: '8px' },
  '.cm-hr': { color: '#ddd', textDecoration: 'line-through', userSelect: 'none' },
});

// ── 源码模式主题（等宽、行号、标准代码编辑器）────────────
const sourceTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': {
    fontFamily: '"Consolas","Courier New",monospace',
    fontSize: '14px', lineHeight: '1.85', padding: '20px 0', overflowX: 'hidden',
  },
  '.cm-content': { padding: '0 28px', caretColor: '#185FA5' },
  '.cm-cursor': { borderLeftColor: '#185FA5', borderLeftWidth: '2px' },
  '.cm-selectionBackground, .cm-focused .cm-selectionBackground': { backgroundColor: '#cce0f5 !important' },
  '.cm-activeLine': { backgroundColor: '#f4f8fd' },
  '.cm-gutters': {
    backgroundColor: '#fafafa', borderRight: '0.5px solid #eee',
    color: '#ccc', minWidth: '42px', fontSize: '12px',
  },
  '.cm-gutterElement': { paddingRight: '10px !important', textAlign: 'right' },
});

// ── Export Modal ─────────────────────────────────────────
function ExportModal({ onConfirm, onCancel }) {
  const [mode, setMode] = useState('keep');
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <FileDown size={14} /><span>导出公文 Word</span>
          <button className="modal-close" onClick={onCancel}><X size={13} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-label">标题编号方式</p>
          <label className="modal-radio">
            <input type="radio" value="keep" checked={mode === 'keep'} onChange={() => setMode('keep')} />
            <span>保留原有编号（适合 AI 生成的已有序号内容）</span>
          </label>
          <label className="modal-radio">
            <input type="radio" value="generate" checked={mode === 'generate'} onChange={() => setMode('generate')} />
            <span>程序自动生成标准编号（一、（一）、1.）</span>
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onCancel}>取消</button>
          <button className="btn-primary-sm" onClick={() => onConfirm(mode)}>
            <Download size={12} /> 确认导出
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Close Confirm Modal ──────────────────────────────────
function CloseConfirmModal({ fileName, onSave, onDiscard, onCancel }) {
  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <div className="modal-header"><span>文件未保存</span></div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>「{fileName || '未命名文档'}」已修改，关闭前是否保存？</p>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onCancel}>取消</button>
          <button className="btn-ghost" style={{ color: '#e53e3e' }} onClick={onDiscard}>
            <RotateCcw size={12} /> 不保存
          </button>
          <button className="btn-primary-sm" onClick={onSave}>
            <Save size={12} /> 保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────
const DEFAULT_CONTENT = `# 新建公文文档\n\n## 一、概述\n\n在此输入正文内容，支持 **加粗**、*斜体* 等格式。\n\n## 二、详细说明\n\n- 第一条说明\n    - 子项内容\n- 第二条说明\n`;

export default function App() {
  const [content, setContent] = useState(DEFAULT_CONTENT);
  const [viewMode, setViewMode] = useState('live');
  const [html, setHtml] = useState('');
  const [outline, setOutline] = useState([]);
  const [isDirty, setIsDirty] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const previewRef = useRef(null);
  const editorRef = useRef(null);

  // 渲染 + 大纲（debounce 300ms）
  useEffect(() => {
    const t = setTimeout(() => {
      const tokens = md.parse(content, {});
      setHtml(md.render(content));
      setOutline(
        tokens.filter((t) => t.type === 'heading_open').map((t) => ({
          level: t.tag,
          text: tokens[tokens.indexOf(t) + 1]?.content || '',
        }))
      );
    }, 300);
    return () => clearTimeout(t);
  }, [content]);

  useEffect(() => {
    window.electronAPI?.setDirty(currentFile?.name || null, isDirty);
  }, [isDirty, currentFile]);

  useEffect(() => {
    window.electronAPI?.onInitFile(({ content: c, filePath }) => {
      setContent(c);
      setCurrentFile({ path: filePath, name: filePath.split(/[\\/]/).pop() });
      setIsDirty(false);
      setViewMode('live');
    });
  }, []);

  useEffect(() => {
    window.electronAPI?.onRequestCloseCheck(() => {
      if (isDirty) setShowCloseModal(true);
      else window.electronAPI.confirmClose();
    });
  }, [isDirty]);

  const handleContentChange = useCallback((val) => {
    setContent(val);
    setIsDirty(true);
  }, []);

  const wordCount = useMemo(() => {
    const s = content.replace(/```[\s\S]*?```/g, '').replace(/[#*`>~_|[\]()!-]/g, '').replace(/https?:\/\/\S+/g, '');
    return (s.match(/[\u4e00-\u9fa5]/g) || []).length + (s.match(/[a-zA-Z]+/g) || []).length;
  }, [content]);

  // ── 两套扩展 ─────────────────────────────────────────
  // 所见即所得：仿宋字体 + livePreviewExt（Decoration.replace 隐藏标记）+ 无行号
  const liveExtensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    liveTheme,
    livePreviewExt,
    EditorView.lineWrapping,
  ], []);

  // 源码：等宽字体 + 行号，不做任何 Markdown 渲染装饰
  const sourceExtensions = useMemo(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    sourceTheme,
    EditorView.lineWrapping,
  ], []);

  const handleOpen = async () => {
    const data = await window.electronAPI?.openFile();
    if (!data) return;
    setContent(data.content);
    setCurrentFile({ path: data.filePath, name: data.filePath.split(/[\\/]/).pop() });
    setIsDirty(false);
    setViewMode('live');
  };

  const handleSave = useCallback(async () => {
    const res = await window.electronAPI?.saveFile(content);
    if (res?.saved) {
      setIsDirty(false);
      if (res.filePath) setCurrentFile({ path: res.filePath, name: res.filePath.split(/[\\/]/).pop() });
    }
  }, [content]);

  const handleSaveAs = async () => {
    const res = await window.electronAPI?.saveFileAs(content);
    if (res?.saved) {
      setIsDirty(false);
      setCurrentFile({ path: res.filePath, name: res.filePath.split(/[\\/]/).pop() });
    }
  };

  useEffect(() => {
    const handler = (e) => {
      if (!e.ctrlKey) return;
      if (e.key === 's') { e.preventDefault(); e.shiftKey ? handleSaveAs() : handleSave(); }
      if (e.key === 'o') { e.preventDefault(); handleOpen(); }
      if (e.key === 'e') { e.preventDefault(); setShowExportModal(true); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  const handleOutlineClick = (text) => {
    if (editorRef.current?.view) {
      const view = editorRef.current.view;
      const lines = content.split('\n');
      const idx = lines.findIndex((l) => l.includes(text));
      if (idx >= 0) {
        const line = view.state.doc.line(idx + 1);
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
        view.focus();
      }
    } else if (previewRef.current) {
      const hs = previewRef.current.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for (const h of hs) {
        if (h.textContent.includes(text)) { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
      }
    }
  };

  // 公文导出（与原版完全一致）
  const handleExport = async (numberMode) => {
    setShowExportModal(false);
    const tokens = md.parse(content, {});
    const docChildren = [];
    let h2n = 0, h3n = 0, h4n = 0;

    const stripNumber = (t) =>
      t.replace(/^[一二三四五六七八九十百]+[、．.]\s*/, '')
       .replace(/^[（(][一二三四五六七八九十]+[）)]\s*/, '')
       .replace(/^\d+[、．.]\s*/, '')
       .replace(/^[(（]\d+[)）]\s*/, '')
       .trim();

    const inlineToRuns = (tok, font, size) => {
      const runs = [];
      let bold = false, italic = false;
      (tok?.children || []).forEach((c) => {
        if (c.type === 'strong_open') bold = true;
        else if (c.type === 'strong_close') bold = false;
        else if (c.type === 'em_open') italic = true;
        else if (c.type === 'em_close') italic = false;
        else if (c.type === 'text' || c.type === 'softbreak')
          runs.push(new TextRun({ text: c.content || ' ', font, size, bold, italics: italic }));
      });
      return runs;
    };

    // ── processList 修复 ─────────────────────────────────────
    // Bug：原版 depthCount 逻辑对几乎所有 token 都递增，导致函数越界吞掉
    // h2/h3 等后续内容全部作为列表项输出。
    // 修复：移除错误的 depthCount，遇到本层 closeType 立即退出，嵌套靠递归处理。
    // 同时兼容 markdown-it 松散列表（inline 包在 paragraph_open/close 里）。
    //
    // 圆点格式修复：原版 bullet 用 '·\t'，制表符在 Word 里产生大段空白。
    // 改为只输出圆点字符本身，通过 hanging indent 自然对齐正文。
    const processList = (toks, start, closeType, depth = 0) => {
      let j = start;
      while (j < toks.length) {
        const t = toks[j];
        // 遇到本层关闭标记，立即退出，返回指向该 token 的下标
        if (t.type === closeType) break;
        // 嵌套列表：递归处理，返回后 j 指向子列表 closeType，j++ 跳过
        if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
          j = processList(toks, j + 1, t.type.replace('open', 'close'), depth + 1);
        } else if (t.type === 'inline') {
          // 不使用 \t，圆点后直接接文字，Word 里不产生额外空格
          const indent = depth === 0 ? { left: 480, hanging: 240 } : { left: 960, hanging: 240 };
          const bullet = depth === 0 ? '·' : '–';
          const runs = inlineToRuns(t, '仿宋_GB2312', 32);
          docChildren.push(new Paragraph({
            alignment: AlignmentType.BOTH, indent,
            spacing: { line: 560, lineRule: 'exact' },
            children: [new TextRun({ text: bullet, font: '仿宋_GB2312', size: 32 }), ...runs],
          }));
        }
        j++;
      }
      // 返回值指向 closeType token；调用方 +1 跳过它
      return j;
    };

    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.type === 'heading_open') {
        const lvl = tok.tag;
        const raw = tokens[i + 1]?.content || '';
        const clean = numberMode === 'generate' ? stripNumber(raw) : raw;
        if (lvl === 'h1') {
          docChildren.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400, after: 400 }, children: [new TextRun({ text: clean, font: '方正小标宋简体', size: 44, bold: true })] }));
        } else if (lvl === 'h2') {
          h2n++; h3n = 0; h4n = 0;
          docChildren.push(new Paragraph({ spacing: { line: 560, lineRule: 'exact', before: 200, after: 200 }, children: [new TextRun({ text: numberMode === 'generate' ? `${ZH[h2n]}、${clean}` : clean, font: '黑体', size: 32 })] }));
        } else if (lvl === 'h3') {
          h3n++; h4n = 0;
          docChildren.push(new Paragraph({ spacing: { line: 560, lineRule: 'exact', before: 200, after: 200 }, children: [new TextRun({ text: numberMode === 'generate' ? `（${ZH[h3n]}）${clean}` : clean, font: '楷体_GB2312', size: 32 })] }));
        } else if (lvl === 'h4') {
          h4n++;
          docChildren.push(new Paragraph({ spacing: { line: 560, lineRule: 'exact', before: 200, after: 200 }, children: [new TextRun({ text: numberMode === 'generate' ? `${h4n}. ${clean}` : clean, font: '仿宋_GB2312', size: 32, bold: true })] }));
        }
        i += 2; continue;
      }
      if (tok.type === 'paragraph_open') {
        const inTok = tokens[i + 1];
        if (inTok?.type === 'inline') {
          const runs = inlineToRuns(inTok, '仿宋_GB2312', 32);
          if (runs.length) docChildren.push(new Paragraph({ alignment: AlignmentType.BOTH, indent: { firstLine: 640 }, spacing: { line: 560, lineRule: 'exact' }, children: runs }));
        }
        i += 3; continue;
      }
      if (tok.type === 'bullet_list_open' || tok.type === 'ordered_list_open') {
        i = processList(tokens, i + 1, tok.type.replace('open', 'close'), 0) + 1;
        continue;
      }
      if (tok.type === 'table_open') {
        const tableTokens = [];
        let j = i;
        while (j < tokens.length && tokens[j].type !== 'table_close') { tableTokens.push(tokens[j]); j++; }
        i = j;
        const rows = [];
        let cells = [], isHdr = false;
        tableTokens.forEach((tt) => {
          if (tt.type === 'tr_open') cells = [];
          else if (tt.type === 'th_open') isHdr = true;
          else if (tt.type === 'td_open') isHdr = false;
          else if (tt.type === 'inline') cells.push({ text: tt.content, isHdr });
          else if (tt.type === 'tr_close' && cells.length)
            rows.push(new TableRow({ children: cells.map((c) => new TableCell({ margins: { top: 80, bottom: 80, left: 120, right: 120 }, shading: c.isHdr ? { fill: 'E8EEF4', type: 'clear' } : undefined, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: c.text, font: '仿宋_GB2312', size: 28, bold: c.isHdr })] })] })) }));
        });
        if (rows.length) {
          const cols = rows[0].options.children.length;
          const cw = Math.floor(8836 / cols);
          const widths = Array(cols).fill(cw);
          widths[cols - 1] = 8836 - cw * (cols - 1);
          docChildren.push(new Table({ width: { size: 8836, type: WidthType.DXA }, columnWidths: widths, rows }));
          docChildren.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
        }
      }
      i++;
    }

    const doc = new Document({ sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 2646, bottom: 2500, left: 1996, right: 1855 } } }, children: docChildren }] });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, `${currentFile?.name?.replace(/\.[^.]+$/, '') || '公文'}_导出.docx`);
  };

  const showSplit = viewMode === 'split';

  return (
    <div className="app-root">
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="app-brand"><FileText size={14} /><span>天马</span></div>
          <div className="top-bar-divider" />
          <button className="tb-btn" onClick={handleOpen} title="Ctrl+O"><FolderOpen size={12} />打开</button>
          <button className="tb-btn" onClick={handleSave} title="Ctrl+S"><Save size={12} />保存{isDirty ? ' ·' : ''}</button>
          <div className="view-switcher">
            <button className={viewMode === 'live' ? 'active' : ''} onClick={() => setViewMode('live')}><Eye size={11} />所见即所得</button>
            <button className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')}><Columns size={11} />分栏</button>
            <button className={viewMode === 'source' ? 'active' : ''} onClick={() => setViewMode('source')}><Edit3 size={11} />源码</button>
          </div>
        </div>
        <div className="top-bar-center">
          <span className="file-title">{currentFile?.name || '未命名文档'}{isDirty ? ' ·' : ''}</span>
        </div>
        <div className="top-bar-right">
          <button className="btn-export" onClick={() => setShowExportModal(true)} title="Ctrl+E">
            <Download size={12} />导出公文 Word
          </button>
        </div>
      </header>

      <main className="main-area">
        {outline.length > 0 && (
          <aside className="outline-panel">
            <div className="outline-header"><List size={11} />大纲</div>
            <div className="outline-scroll">
              {outline.map((h, i) => (
                <div key={i} className={`outline-item ol-${h.level}`} onClick={() => handleOutlineClick(h.text)} title={h.text}>
                  {h.text}
                </div>
              ))}
            </div>
          </aside>
        )}

        {/* ── 所见即所得：仿宋 + Decoration.replace 隐藏标记符 + 无行号 ── */}
        {viewMode === 'live' && (
          <section className="editor-pane">
            <CodeMirror
              ref={editorRef}
              value={content}
              height="100%"
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
              }}
              extensions={liveExtensions}
              onChange={handleContentChange}
              style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            />
          </section>
        )}

        {/* ── 分栏：左源码 + 右预览 ── */}
        {viewMode === 'split' && (
          <>
            <section className="editor-pane pane-split">
              <div className="pane-bar"><Edit3 size={10} />源码编辑</div>
              <CodeMirror
                ref={editorRef}
                value={content}
                height="100%"
                extensions={sourceExtensions}
                onChange={handleContentChange}
                style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
              />
            </section>
            <section className="preview-pane">
              <div className="pane-bar"><Eye size={10} />实时预览</div>
              <div
                ref={previewRef}
                className="prose"
                style={{ flex: 1, padding: '28px 36px', overflowY: 'auto' }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </section>
          </>
        )}

        {/* ── 源码：等宽 + 行号，纯 Markdown 文本 ── */}
        {viewMode === 'source' && (
          <section className="editor-pane">
            <div className="pane-bar"><Edit3 size={10} />源码编辑 · Markdown 原始格式</div>
            <CodeMirror
              ref={editorRef}
              value={content}
              height="100%"
              extensions={sourceExtensions}
              onChange={handleContentChange}
              style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            />
          </section>
        )}
      </main>

      <footer className="status-bar">
        <span className="status-dot" /><span>{currentFile ? '已就绪' : '新建文档'}</span>
        <span className="status-sep" /><span>字数 {wordCount.toLocaleString()}</span>
        <span className="status-sep" /><span>{viewMode === 'live' ? '所见即所得' : viewMode === 'split' ? '分栏预览' : '源码模式'}</span>
        <span className="status-hints">Ctrl+S 保存 · Ctrl+O 打开 · Ctrl+E 导出</span>
      </footer>

      {showExportModal && <ExportModal onConfirm={handleExport} onCancel={() => setShowExportModal(false)} />}
      {showCloseModal && (
        <CloseConfirmModal
          fileName={currentFile?.name}
          onSave={async () => { await handleSave(); window.electronAPI.confirmClose(); }}
          onDiscard={() => window.electronAPI.confirmClose()}
          onCancel={() => setShowCloseModal(false)}
        />
      )}
    </div>
  );
}
