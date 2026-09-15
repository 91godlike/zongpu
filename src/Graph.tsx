import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Download, Focus, Maximize, Minus, Plus, Route } from 'lucide-react';
import type { GraphData } from './types';
import { displayedBirth } from './types';
import { apiUrl, saveBlob } from './api';
import { CARD_WIDTH as W, CARD_HEIGHT as H, createFamilyLayout, highlightRelations } from './family-layout';
export { relatives, pathBetween } from './family-layout';

const SERIF = '"Songti SC", "STSong", serif';
const SANS = '"PingFang SC", "Microsoft YaHei", sans-serif';
const MIN_SCALE = .04;
const MAX_SCALE = 1.8;
const CLEAR_SCALE = 1;
type Camera = { x: number; y: number; scale: number };
const railWidth = (viewportWidth: number) => viewportWidth < 760 ? 72 : 104;

function boundedCamera(camera: Camera, layout: { width: number; height: number }, viewport: { width: number; height: number }) {
  if (!viewport.width || !viewport.height) return camera;
  const rail = railWidth(viewport.width), visibleWidth = viewport.width / camera.scale, visibleContentWidth = (viewport.width - rail) / camera.scale;
  const visibleHeight = viewport.height / camera.scale;
  const minX = -rail / camera.scale, maxX = layout.width - visibleWidth;
  const x = visibleContentWidth >= layout.width
    ? minX + (layout.width - visibleContentWidth) / 2
    : Math.min(maxX, Math.max(minX, camera.x));
  const y = visibleHeight >= layout.height ? 0 : Math.min(layout.height - visibleHeight, Math.max(0, camera.y));
  return { ...camera, x, y };
}

export function Graph({ data, selected, onSelect, onOpenFamily, root, depth, mode, startGeneration }: {
  data: GraphData; selected: string; onSelect: (id: string) => void; onOpenFamily: (id: string) => void; root: string; depth: number; mode: string; startGeneration: number;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: CLEAR_SCALE });
  const cameraRef = useRef(camera);
  const [exporting, setExporting] = useState(false), [ancestors, setAncestors] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<null | { kind: 'drag'; x: number; y: number; camera: Camera } | { kind: 'pinch'; distance: number; camera: Camera; worldX: number; worldY: number }>(null);
  const viewKey = `${root}|${depth}|${mode}|${startGeneration}`;
  const viewResetKey = `${viewKey}|${data.people.length}|${data.relations.length}`;
  const previousViewKey = useRef('');
  useEffect(() => { setAncestors(false); }, [selected]);
  const layout = useMemo(() => createFamilyLayout(data, { root, depth: mode === 'kin' ? 8 : depth, mode, startGeneration }), [data, root, depth, mode, startGeneration]);
  const contentBounds = useMemo(() => {
    if (!layout.nodes.length) return { left: 0, top: 0, right: layout.width, bottom: layout.height };
    return {
      left: Math.min(...layout.nodes.map(node => node.x)),
      top: Math.min(...layout.nodes.map(node => node.y)),
      right: Math.max(...layout.nodes.map(node => node.x + W)),
      bottom: Math.max(...layout.nodes.map(node => node.y + H)),
    };
  }, [layout]);
  const contentWidth = Math.max(1, contentBounds.right - contentBounds.left);
  const contentHeight = Math.max(1, contentBounds.bottom - contentBounds.top);
  const highlights = useMemo(() => highlightRelations(layout.relations, selected, ancestors), [layout.relations, selected, ancestors]);
  const byKey = new Map(layout.nodes.map(p => [p.key, p]));
  const ancestorFamily = (parents: string[], child: string) => layout.relations.some(r => r.type !== 'partner' && r.target === child && parents.includes(r.source) && highlights.ids.has(r.id));

  useLayoutEffect(() => {
    if (!svg.current) return;
    const measure = () => {
      const rect = svg.current!.getBoundingClientRect();
      setViewport({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);

  const applyCamera = (next: Camera) => {
    const value = boundedCamera({ ...next, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale)) }, layout, viewport);
    cameraRef.current = value;
    setCamera(value);
  };
  const fitView = () => {
    if (!viewport.width || !viewport.height) return;
    const rail = railWidth(viewport.width), padding = 18;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((viewport.width - rail - padding * 2) / contentWidth, (viewport.height - padding * 2) / contentHeight)));
    const usableCenterX = rail + (viewport.width - rail) / 2;
    applyCamera({ x: contentBounds.left + contentWidth / 2 - usableCenterX / scale, y: contentBounds.top - padding / scale, scale });
  };
  const clearView = () => {
    if (!viewport.width || !viewport.height) return;
    const rail = railWidth(viewport.width), scale = viewport.width < 760 ? .8 : CLEAR_SCALE;
    const focus = layout.nodes.find(node => node.id === root && !node.reference) || layout.nodes.find(node => node.level === 0 && !node.reference) || layout.nodes[0];
    const center = focus ? focus.x + W / 2 : layout.width / 2;
    applyCamera({ x: center - (rail + (viewport.width - rail) / 2) / scale, y: 0, scale });
  };
  const setScaleAt = (scale: number, screenX = viewport.width / 2, screenY = viewport.height / 2) => {
    const current = cameraRef.current, nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const worldX = current.x + screenX / current.scale, worldY = current.y + screenY / current.scale;
    applyCamera({ x: worldX - screenX / nextScale, y: worldY - screenY / nextScale, scale: nextScale });
  };

  useEffect(() => {
    if (!viewport.width || !viewport.height) return;
    if (previousViewKey.current !== viewResetKey) {
      previousViewKey.current = viewResetKey;
      if (mode === 'kin' || mode === 'branch' || (mode === 'tree' && depth === 0 && startGeneration === 1)) fitView(); else clearView();
    } else applyCamera(cameraRef.current);
  }, [viewResetKey, mode, depth, startGeneration, viewport.width, viewport.height, layout.width, layout.height]);

  async function exportImage() {
    if (!svg.current) return;
    setExporting(true);
    let url = '';
    try {
      const clone = svg.current.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
      clone.setAttribute('width', String(layout.width)); clone.setAttribute('height', String(layout.height));
      clone.querySelectorAll('[data-controls]').forEach(element => element.remove());
      clone.querySelectorAll<SVGGElement>('[data-generation-label]').forEach(element => {
        element.classList.remove('generation-label-hidden');
        element.setAttribute('transform', `translate(20 ${element.dataset.generationY || 0})`);
      });
      const source = new XMLSerializer().serializeToString(clone);
      url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; img.src = url; });
      const canvas = document.createElement('canvas'), scale = Math.min(2, 8000 / Math.max(layout.width, layout.height));
      canvas.width = layout.width * scale; canvas.height = layout.height * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fbfaf6'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('无法生成图片');
      saveBlob(blob, '家谱图.png');
    } catch { alert('图片导出失败，请使用浏览器打印保存 PDF。'); }
    finally { if (url) URL.revokeObjectURL(url); setExporting(false); }
  }
  useEffect(() => { const listener = () => void exportImage(); window.addEventListener('zongpu:export-png', listener); return () => window.removeEventListener('zongpu:export-png', listener); });
  return <div className="graph-area family-graph">
    <div className="graph-context" data-controls>
      <span>{mode === 'kin' ? '查看家庭 · 显示当前人物的上一辈和下一辈' : mode === 'branch' ? `分支展开 · 从第 ${startGeneration} 代显示全部后代` : `全部家人 · 从第 ${startGeneration} 代开始`}</span>
    </div>
    <svg ref={svg} className="tree-svg" viewBox={`${camera.x} ${camera.y} ${viewport.width ? viewport.width / camera.scale : layout.width} ${viewport.height ? viewport.height / camera.scale : layout.height}`} preserveAspectRatio="xMinYMin meet" role="img" aria-label="家谱图，可点击人物查看资料"
      onWheel={event => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setScaleAt(cameraRef.current.scale * Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top); }}
      onPointerDown={event => {
        if (event.pointerType !== 'touch' && (event.target as Element).closest('[data-person], [data-controls]')) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId);
        const values = [...pointers.current.values()];
        if (values.length === 1) gesture.current = { kind: 'drag', x: event.clientX, y: event.clientY, camera: cameraRef.current };
        else if (values.length === 2) {
          const [a, b] = values, rect = event.currentTarget.getBoundingClientRect(), midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
          gesture.current = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), camera: cameraRef.current,
            worldX: cameraRef.current.x + (midX - rect.left) / cameraRef.current.scale, worldY: cameraRef.current.y + (midY - rect.top) / cameraRef.current.scale };
        }
      }}
      onPointerMove={event => {
        if (!pointers.current.has(event.pointerId) || !gesture.current) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const values = [...pointers.current.values()];
        if (values.length >= 2 && gesture.current.kind === 'pinch') {
          const [a, b] = values, rect = event.currentTarget.getBoundingClientRect(), midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
          const scale = gesture.current.camera.scale * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.current.distance);
          const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
          applyCamera({ x: gesture.current.worldX - (midX - rect.left) / nextScale, y: gesture.current.worldY - (midY - rect.top) / nextScale, scale: nextScale });
        } else if (values.length === 1 && gesture.current.kind === 'drag') {
          applyCamera({ x: gesture.current.camera.x - (event.clientX - gesture.current.x) / gesture.current.camera.scale,
            y: gesture.current.camera.y - (event.clientY - gesture.current.y) / gesture.current.camera.scale, scale: gesture.current.camera.scale });
        }
      }}
      onPointerUp={event => {
        pointers.current.delete(event.pointerId);
        const remaining = [...pointers.current.values()][0];
        gesture.current = remaining ? { kind: 'drag', x: remaining.x, y: remaining.y, camera: cameraRef.current } : null;
      }} onPointerCancel={event => { pointers.current.delete(event.pointerId); gesture.current = null; }}>
      <rect x="-100000" y="-100000" width="200000" height="200000" fill="#fbfaf6" />
      {layout.rows.map(row => <g key={row.level}>
        <g className={camera.scale < .18 ? 'generation-label-hidden' : undefined} data-generation-label data-generation-y={row.y + H / 2} transform={`translate(${camera.x + 18 / camera.scale} ${row.y + H / 2}) scale(${1 / camera.scale})`}>
          <rect x="-18" y="-25" width={railWidth(viewport.width)} height="48" fill="#fbfaf6" />
          <text x="0" y="3" fontSize="14" fontFamily={SANS} fontWeight="700" fill="#666d63">{row.label.replaceAll(' ', '')}（{row.count}）</text>
        </g>
      </g>)}
      {layout.families.map(family => {
        const parents = family.parentKeys.map(key => byKey.get(key)!);
        const children = family.childKeys.map(key => byKey.get(key)!);
        const multiple = parents.length > 1, jointY = multiple && parents.length === 2 ? family.y + H / 2 : family.y + H + 18;
        const busY = family.y + H + 58;
        const related = !ancestors && (family.parents.includes(selected) || family.children.includes(selected));
        const color = related ? '#527b67' : '#93a799';
        const childXs = children.map(child => child.x + W / 2);
        return <g key={family.key} data-family={family.id}>
          {parents.length === 2 && <>
            <path d={`M${parents[0].x + W} ${jointY} H${parents[1].x}`} fill="none" stroke={family.partner ? '#b08b76' : color} strokeWidth="2.2" />
            {family.partner && <text x={family.x} y={jointY - 9} textAnchor="middle" fontFamily={SANS} fontSize="10" fontWeight="600" fill="#9a705b">配偶</text>}
          </>}
          {parents.length > 2 && <path d={`M${parents[0].x + W / 2} ${jointY} H${parents.at(-1)!.x + W / 2} ${parents.map(p => `M${p.x + W / 2} ${p.y + H} V${jointY}`).join(' ')}`} fill="none" stroke={color} strokeWidth="2.8" />}
          {parents.length === 1 && family.childCount > 0 && <path d={`M${family.x} ${family.y + H} V${jointY}`} stroke={color} strokeWidth="2.8" />}
          {children.length > 0 && <>
            <path d={`M${family.x} ${jointY} V${busY} M${Math.min(family.x, ...childXs)} ${busY} H${Math.max(family.x, ...childXs)} ${children.map(child => `M${child.x + W / 2} ${busY} V${child.y}`).join(' ')}`} fill="none" stroke={color} strokeWidth="2.8" strokeLinejoin="round" />
            {ancestors && children.filter(child => ancestorFamily(family.parents, child.id)).map(child => <path key={child.key} d={`M${family.x} ${jointY} V${busY} H${child.x + W / 2} V${child.y}`} fill="none" stroke="#46735b" strokeWidth="3.6" />)}
          </>}
          {multiple && <circle cx={family.x} cy={jointY} r="3" fill="#fbfaf6" stroke={color} strokeWidth="1.4" />}
        </g>;
      })}
      {layout.nodes.map((person, index) => {
        const active = person.id === selected, relative = highlights.people.has(person.id), female = person.gender === 'female';
        const clipId = `avatar-clip-${index}`;
        const displayName = person.name.length > 6 ? person.name.slice(0, 6) + '…' : person.name;
        const avatarX = person.x + (W - 108) / 2;
        const birth = displayedBirth(person);
        const death = person.status === 'deceased' ? person.death : '';
        const lifeDates = birth ? `${birth}${death ? ` — ${death}` : ''}` : death ? `— ${death}` : '';
        return <g key={person.key} data-person={person.id} data-occurrence={person.key} data-reference={person.reference || undefined} role="button" tabIndex={0} aria-label={`查看${person.name}${person.reference ? '（同一人物引用）' : ''}`} onClick={() => onSelect(person.id)} onDoubleClick={event => { event.stopPropagation(); onOpenFamily(person.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(person.id); } }} style={{ cursor: 'pointer' }}>
          <title>{person.name} · 双击查看家庭{person.reference ? ' · 同一档案在另一家庭中的引用' : ''}</title>
          <rect x={person.x} y={person.y} width={W} height={H} rx="10" fill={active ? '#edf4ed' : '#fffdf9'} stroke={active ? '#3b7055' : relative ? '#91ad97' : female ? '#d9c5b4' : '#c4d0c2'} strokeWidth={active ? '2.2' : '1.4'} />
          {person.avatarId ? <>
            <defs><clipPath id={clipId}><rect x={avatarX} y={person.y + 4} width="108" height="108" rx="10" /></clipPath></defs>
            <image href={apiUrl(`/api/attachments/${person.avatarId}?thumb=1`)} x={avatarX} y={person.y + 4} width="108" height="108" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
            <rect x={avatarX} y={person.y + 4} width="108" height="108" rx="10" fill="none" stroke={female ? '#d9c5b4' : '#c4d0c2'} strokeWidth="1.2" />
            <text x={person.x + W / 2} y={person.y + 136} textAnchor="middle" fontFamily={SERIF} fontSize={person.name.length > 4 ? 17 : 20} fontWeight="800" fill={female ? '#995e4b' : '#305846'}>{displayName}</text>
            {birth && <text x={person.x + W / 2} y={person.y + 158} textAnchor="middle" fontFamily={SANS} fontSize="11" fontWeight="600" fill="#888579">{birth}</text>}
          </> : <>
            <text x={person.x + W / 2} y={person.y + 77} textAnchor="middle" fontFamily={SERIF} fontSize={person.name.length > 5 ? 18 : 22} fontWeight="800" fill={female ? '#995e4b' : '#305846'}>{displayName}</text>
            {lifeDates && <text x={person.x + W / 2} y={person.y + 105} textAnchor="middle" fontFamily={SANS} fontSize="12" fontWeight="600" fill="#888579">{lifeDates}</text>}
          </>}
          {person.reference && <text x={person.x + W / 2} y={person.y + 157} textAnchor="middle" fontFamily={SANS} fontSize="10" fontWeight="600" fill="#9b8d73">↗ 同一人物引用</text>}
        </g>;
      })}
    </svg>
    {!layout.nodes.length && <div className="canvas-empty"><h3>从一位家人开始</h3><p>添加人物，再连接父母、配偶与子女。</p></div>}
    {viewport.width > 0 && (contentWidth > (viewport.width - railWidth(viewport.width)) / camera.scale * 1.05 || contentHeight > viewport.height / camera.scale * 1.05) && <button className="graph-minimap" aria-label="家谱缩略导航，点击可移动视图" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect(), worldX = contentBounds.left + (event.clientX - rect.left) / rect.width * contentWidth, worldY = contentBounds.top + (event.clientY - rect.top) / rect.height * contentHeight;
      applyCamera({ ...cameraRef.current, x: worldX - viewport.width / cameraRef.current.scale / 2, y: worldY - viewport.height / cameraRef.current.scale / 2 });
    }}>
      <svg viewBox={`${contentBounds.left - 20} ${contentBounds.top - 20} ${contentWidth + 40} ${contentHeight + 40}`} preserveAspectRatio="none" aria-hidden="true">
        {layout.nodes.map(node => <rect key={node.key} x={node.x} y={node.y} width={W} height={H} rx="8" fill={node.gender === 'female' ? '#b98673' : '#5e8271'} />)}
        <rect className="minimap-viewport" x={camera.x} y={camera.y} width={viewport.width / camera.scale} height={viewport.height / camera.scale} />
      </svg>
    </button>}
    <div className="graph-bottom"><div className="zoom-controls">
      <button aria-label="缩小" onClick={() => setScaleAt(cameraRef.current.scale - .1)}><Minus size={17} /></button><span>{Math.round(camera.scale * 100)}%</span>
      <button aria-label="放大" onClick={() => setScaleAt(cameraRef.current.scale + .1)}><Plus size={17} /></button>
      <button className="zoom-mode" aria-label="清晰阅读" onClick={clearView}><Focus size={16} /><span>清晰</span></button>
      <button className="zoom-mode" aria-label="适应全图" onClick={fitView}><Maximize size={16} /><span>全图</span></button>
      {selected && <button className="zoom-mode ancestry-path" aria-pressed={ancestors} onClick={() => setAncestors(value => !value)}><Route size={16} /><span>{ancestors ? '返回家人' : '祖辈路径'}</span></button>}
    </div><div className="legend"><span><i />父母子女</span><span><i className="marriage" />配偶</span></div>
      <button className="icon-button export-png" aria-label="导出家谱图 PNG" onClick={exportImage} disabled={exporting}><Download size={17} /></button>
    </div>
    <div className="canvas-count">显示 {layout.personCount} 位家人{layout.referenceCount ? ` · ${layout.referenceCount} 处同一人物引用` : ''} · 单击查看资料 · 双击查看家庭 · 拖动或缩放{layout.truncated ? ' · 内容较多，请选择人物分段查看' : ''}</div>
  </div>;
}
