import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from 'd3-force';

interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
  index?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
}

interface GraphData {
  nodes: Array<{ id: string; title: string; type: string; tags: string[] }>;
  links: Array<{ source: string; target: string }>;
}

const NODE_COLOR = '#9ca3af';
const NODE_HOVER_COLOR = '#e5e7eb';
const TAG_COLOR = '#fb7185';
const TAG_HOVER_COLOR = '#fda4af';
const LINK_COLOR = 'rgba(120,120,120,0.15)';
const LINK_HOVER_COLOR = 'rgba(160,160,160,0.45)';
const LABEL_COLOR = 'rgba(156,163,175,0.6)';
const LABEL_HOVER_COLOR = '#d1d5db';

const TYPE_COLORS: Record<string, { normal: string; hover: string }> = {
  concept:      { normal: '#60a5fa', hover: '#93bbfd' },
  entity:       { normal: '#34d399', hover: '#6ee7b7' },
  summary:      { normal: '#c084fc', hover: '#d8b4fe' },
  conversation: { normal: '#fbbf24', hover: '#fcd34d' },
  index:        { normal: '#f87171', hover: '#fca5a5' },
};

const TYPE_LABELS: Record<string, string> = {
  concept: 'Concept',
  entity: 'Entity',
  summary: 'Summary',
  conversation: 'Conversation',
  index: 'Index',
  tag: 'Tag',
};

const CFG = {
  centerForce: 0.25,
  repulsion: 120,
  linkForce: 0.5,
  linkDistance: 100,
  linkWidth: 0.8,
  nodeSize: 1,
} as const;

const isTagNode = (id: string) => id.startsWith('__tag__');

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildRelatedSet(hovered: string | null, links: GraphLink[]): Set<string> {
  const related = new Set<string>();
  if (!hovered) return related;
  for (const link of links) {
    const sid = (link.source as GraphNode).id;
    const tid = (link.target as GraphNode).id;
    if (sid === hovered) related.add(tid);
    if (tid === hovered) related.add(sid);
  }
  return related;
}

interface Props {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function KnowledgeGraph({ data, onNodeClick }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const simulationRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ node: GraphNode | null; startX: number; startY: number; moved: boolean }>({
    node: null, startX: 0, startY: 0, moved: false,
  });
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const width = 800;
  const height = 500;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { x: tx, y: ty, scale } = transformRef.current;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const nodes = nodesRef.current;
    const links = linksRef.current;
    const hovered = hoveredRef.current;
    const related = buildRelatedSet(hovered, links);

    // === Links ===
    for (const link of links) {
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      if (source.x == null || target.x == null) continue;

      const isTagLink = isTagNode(source.id) || isTagNode(target.id);
      const isRelatedToHover = hovered != null && (source.id === hovered || target.id === hovered);
      const isDimmed = hovered != null && !isRelatedToHover;

      const srcType = (typeof link.source === 'object' ? (link.source as GraphNode).type : '');
      const srcColor = TYPE_COLORS[srcType]?.normal ?? '#999';
      ctx.strokeStyle = isRelatedToHover
        ? (isTagLink ? hexToRgba(TAG_COLOR, 0.4) : hexToRgba(srcColor, 0.4))
        : LINK_COLOR;
      ctx.lineWidth = isRelatedToHover
        ? (isTagLink ? 0.8 : CFG.linkWidth * 1.5)
        : (isTagLink ? 0.4 : CFG.linkWidth);
      if (isDimmed) ctx.globalAlpha = 0.08;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Connection counts — all links (including tag links)
    const connCount = new Map<string, number>();
    for (const link of links) {
      const sid = (link.source as GraphNode).id;
      const tid = (link.target as GraphNode).id;
      connCount.set(sid, (connCount.get(sid) ?? 0) + 1);
      connCount.set(tid, (connCount.get(tid) ?? 0) + 1);
    }

    // === Tag nodes ===
    for (const node of nodes) {
      if (node.x == null || !isTagNode(node.id)) continue;
      const isHovered = hovered === node.id;
      const isDimmed = hovered != null && hovered !== node.id && !related.has(node.id);
      if (isDimmed) ctx.globalAlpha = 0.08;

      const r = isHovered ? 3 : 2;

      ctx.fillStyle = isHovered ? TAG_HOVER_COLOR : TAG_COLOR;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (isHovered) {
        ctx.fillStyle = 'rgba(15,23,42,0.85)';
        ctx.font = '500 10px system-ui, sans-serif';
        const m = ctx.measureText(node.title);
        const pw = m.width + 10;
        const ph = 18;
        ctx.beginPath();
        ctx.roundRect(node.x - pw / 2, node.y - r - ph - 5, pw, ph, 4);
        ctx.fill();
        ctx.fillStyle = TAG_HOVER_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.title, node.x, node.y - r - ph / 2 - 5);
      }
      ctx.globalAlpha = 1;
    }

    // === Page nodes ===
    for (const node of nodes) {
      if (node.x == null || isTagNode(node.id)) continue;
      const connections = connCount.get(node.id) ?? 0;
      const baseR = (3 + Math.sqrt(connections) * 1.8) * CFG.nodeSize;
      const isHovered = hovered === node.id;
      const isDimmed = hovered != null && hovered !== node.id && !related.has(node.id);
      if (isDimmed) ctx.globalAlpha = 0.08;

      const r = isHovered ? baseR + 2 : baseR;

      const colors = TYPE_COLORS[node.type] ?? { normal: NODE_COLOR, hover: NODE_HOVER_COLOR };
      ctx.fillStyle = isHovered ? colors.hover : colors.normal;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Label — only show when hovered or zoomed in
      const shouldShowLabel = isHovered || scale > 0.7 || related.has(node.id);
      if (shouldShowLabel) {
        const label = node.title.length > 22 ? node.title.slice(0, 20) + '..' : node.title;
        ctx.font = `${isHovered ? '500 10px' : '400 9px'} system-ui, sans-serif`;
        ctx.fillStyle = isHovered ? LABEL_HOVER_COLOR : LABEL_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, node.x, node.y + r + 3);
      }
      ctx.globalAlpha = 1;
    }

    // === Tooltip for hovered page node ===
    if (hovered && !isTagNode(hovered)) {
      const node = nodes.find((n) => n.id === hovered);
      if (node && node.x != null) {
        const typeLabel = TYPE_LABELS[node.type] ?? node.type;
        const line2 = node.tags.length > 0
          ? `${typeLabel} · ${node.tags.slice(0, 3).join(', ')}`
          : typeLabel;

        ctx.font = '500 11px system-ui, sans-serif';
        const m1 = ctx.measureText(node.title);
        ctx.font = '400 10px system-ui, sans-serif';
        const m2 = ctx.measureText(line2);
        const tw = Math.max(m1.width, m2.width) + 16;
        const th = 42;
        const ttx = node.x - tw / 2;
        const tty = node.y - th - 12;

        ctx.fillStyle = 'rgba(15,23,42,0.9)';
        ctx.beginPath();
        ctx.roundRect(ttx, tty, tw, th, 5);
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,60,70,0.4)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        ctx.fillStyle = '#e5e7eb';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = '500 11px system-ui, sans-serif';
        ctx.fillText(node.title, node.x, tty + 7);

        ctx.fillStyle = '#6b7280';
        ctx.font = '400 10px system-ui, sans-serif';
        ctx.fillText(line2, node.x, tty + 24);
      }
    }

    ctx.restore();
  }, [width, height]);

  const getNodeAt = useCallback((mouseX: number, mouseY: number): GraphNode | null => {
    const { x: tx, y: ty, scale } = transformRef.current;
    const wx = (mouseX - tx) / scale;
    const wy = (mouseY - ty) / scale;

    const connCount = new Map<string, number>();
    for (const link of linksRef.current) {
      const sid = (link.source as GraphNode).id;
      const tid = (link.target as GraphNode).id;
      connCount.set(sid, (connCount.get(sid) ?? 0) + 1);
      connCount.set(tid, (connCount.get(tid) ?? 0) + 1);
    }

    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (node.x == null) continue;
      if (isTagNode(node.id)) {
        const dx = wx - node.x;
        const dy = wy - node.y;
        if (dx * dx + dy * dy <= 36) return node;
        continue;
      }
      const c = connCount.get(node.id) ?? 0;
      const r = (3 + Math.sqrt(c) * 1.8) * CFG.nodeSize + 4;
      const dx = wx - node.x;
      const dy = wy - node.y;
      if (dx * dx + dy * dy <= r * r) return node;
    }
    return null;
  }, []);

  useEffect(() => {
    if (data.nodes.length === 0) return;

    const nodes: GraphNode[] = data.nodes.map((n) => ({ ...n, tags: n.tags ?? [] }));
    const links: GraphLink[] = data.links.map((l) => ({ ...l }));
    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation<GraphNode>(nodes)
      .force('link', forceLink<GraphNode, GraphLink>(links).id((d) => d.id).strength(CFG.linkForce).distance(CFG.linkDistance))
      .force('charge', forceManyBody().strength((d) => isTagNode(d.id) ? -CFG.repulsion * 0.4 : -CFG.repulsion))
      .force('x', forceX(width / 2).strength(CFG.centerForce))
      .force('y', forceY(height / 2).strength(CFG.centerForce))
      .force('collide', forceCollide<GraphNode>().radius((d) => isTagNode(d.id) ? 5 : 12))
      .on('tick', draw);

    simulationRef.current = sim;
    return () => { sim.stop(); };
  }, [data, draw, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (panStartRef.current) {
        transformRef.current.x = panStartRef.current.tx + (e.clientX - panStartRef.current.x);
        transformRef.current.y = panStartRef.current.ty + (e.clientY - panStartRef.current.y);
        draw();
        return;
      }
      if (dragRef.current.node) {
        if ((e.clientX - dragRef.current.startX) ** 2 + (e.clientY - dragRef.current.startY) ** 2 > 9) {
          dragRef.current.moved = true;
        }
        const { x: tx, y: ty, scale } = transformRef.current;
        dragRef.current.node.fx = (mx - tx) / scale;
        dragRef.current.node.fy = (my - ty) / scale;
        simulationRef.current?.alpha(0.3).restart();
        return;
      }

      const node = getNodeAt(mx, my);
      const id = node?.id ?? null;
      if (id !== hoveredRef.current) {
        hoveredRef.current = id;
        canvas.style.cursor = id ? 'pointer' : 'default';
        draw();
      }
    };

    const onDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (e.button === 0) {
        const node = getNodeAt(mx, my);
        if (node) {
          dragRef.current = { node, startX: e.clientX, startY: e.clientY, moved: false };
          canvas.style.cursor = 'grabbing';
        } else {
          panStartRef.current = { x: e.clientX, y: e.clientY, tx: transformRef.current.x, ty: transformRef.current.y };
        }
      }
    };

    const onUp = () => {
      if (dragRef.current.node) {
        const clicked = dragRef.current.node;
        clicked.fx = null;
        clicked.fy = null;
        simulationRef.current?.alpha(0.3).restart();
        if (!dragRef.current.moved && onNodeClick && !isTagNode(clicked.id)) {
          onNodeClick(clicked.id);
        }
        dragRef.current = { node: null, startX: 0, startY: 0, moved: false };
        canvas.style.cursor = hoveredRef.current ? 'pointer' : 'default';
      }
      panStartRef.current = null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const f = e.deltaY < 0 ? 1.1 : 0.9;
      const ns = Math.max(0.15, Math.min(5, transformRef.current.scale * f));
      transformRef.current.x = mx - (mx - transformRef.current.x) * (ns / transformRef.current.scale);
      transformRef.current.y = my - (my - transformRef.current.y) * (ns / transformRef.current.scale);
      transformRef.current.scale = ns;
      draw();
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mouseleave', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [draw, getNodeAt, onNodeClick]);

  const hasTags = data.nodes.some((n) => n.type === 'tag');
  const typeSet = useMemo(
    () => [...new Set(data.nodes.map((n) => n.type).filter((t) => t !== 'tag' && TYPE_COLORS[t]))],
    [data.nodes],
  );

  if (data.nodes.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-12">
        {t('kb.noWikiPages')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-xs text-muted-foreground/60">
        {typeSet.map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type]?.normal }} />
            <span>{TYPE_LABELS[type] ?? type}</span>
          </div>
        ))}
        {hasTags && (
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: TAG_COLOR }} />
            <span>Tag</span>
          </div>
        )}
        <span className="ml-auto">Scroll to zoom · Drag to pan · Click to view</span>
      </div>
      <div className="border border-border/40 rounded-lg overflow-hidden bg-background">
        <canvas ref={canvasRef} style={{ width, height }} className="w-full h-auto block" />
      </div>
    </div>
  );
}
