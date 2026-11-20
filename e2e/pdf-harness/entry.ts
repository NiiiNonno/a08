/**
 * PDF.js の標準のビューア（Obsidian の PDF ビューアの元）の上で、local/pdf.ts を動かす。
 * Obsidian の PDF ビューの形（view.viewer.child.pdfViewer.{eventBus,pdfViewer}）をまねて渡す。
 */
import * as pdfjs from 'pdfjs-dist';
import { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { PdfAnnotations, type PdfAnno } from '../../packages/obsidian-plugin/src/local/pdf.ts';
import { PdfTextModel } from '../../packages/core/src/pdf-text.ts';
import { DEFAULT_STYLES_YAML, parseStyleConfig } from '../../packages/core/src/styles.ts';
import { buildLocalCss } from '../../packages/obsidian-plugin/src/local/styles.ts';

// プラグインと同じく、既定のハイライトのスタイルから CSS を作って入れる
document.head.appendChild(document.createElement('style')).textContent = buildLocalCss(parseStyleConfig(DEFAULT_STYLES_YAML).config);

pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

const state: { annos: PdfAnno[]; clicked: string[]; loaded: number } = { annos: [], clicked: [], loaded: 0 };
let pdf: PdfAnnotations;
let view: any;

async function open(bytes: number[]) {
  const container = document.getElementById('viewerContainer') as HTMLDivElement;
  const eventBus = new EventBus();
  const pdfViewer = new PDFViewer({ container, eventBus });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  view = {
    getViewType: () => 'pdf',
    file: { path: 'paper.pdf' },
    containerEl: document.body,
    viewer: { child: { pdfViewer: { eventBus, pdfViewer } } },
  };
  const app: any = {
    workspace: { getLeavesOfType: (t: string) => (t === 'pdf' ? [{ view }] : []) },
    vault: { getAbstractFileByPath: () => null },
  };
  pdf = new PdfAnnotations(app, {
    loaded: () => void state.loaded++,
    annos: () => state.annos,
    clicked: (_p, id) => void state.clicked.push(id),
  });
  pdf.attachAll();
  const pagesLoaded = new Promise(r => eventBus.on('pagesloaded', r));
  pdfViewer.setDocument(doc);
  await pagesLoaded;
  pdfViewer.currentScaleValue = '1';
}

async function model(): Promise<{ text: string; starts: number[] }> {
  const m = (await pdf.textModel('paper.pdf')) as PdfTextModel;
  pdf.setReady('paper.pdf', m);
  return { text: m.text, starts: m.starts };
}

function setAnnos(annos: PdfAnno[]) {
  state.annos = annos;
  pdf.draw('paper.pdf');
}

(window as any).harness = {
  open,
  model,
  setAnnos,
  state,
  selection: () => pdf.selection(view),
  hitTest: (x: number, y: number) => pdf.hitTest(view, x, y),
  linkTarget: (s: number, e: number) => pdf.linkTarget('paper.pdf', s, e),
  reveal: (id: string, start: number) => pdf.reveal(view, 'paper.pdf', id, start),
  scale: (v: string) => ((view.viewer.child.pdfViewer.pdfViewer as PDFViewer).currentScaleValue = v),
};
