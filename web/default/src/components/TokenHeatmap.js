import React, { useEffect, useMemo, useState } from 'react';
import { Button, Dimmer, Dropdown, Header, Loader, Modal, Table } from 'semantic-ui-react';
import { API, showError } from '../helpers';

const GRAN_OPTIONS = [
  { key: '10m', text: '10 分钟', value: 600 },
  { key: '1h', text: '小时', value: 3600 },
  { key: '1d', text: '天', value: 86400 },
];
const SPAN_OPTIONS = [
  { key: 's', text: '24 桶', value: 24 },
  { key: 'm', text: '72 桶', value: 72 },
  { key: 'l', text: '144 桶', value: 144 },
  { key: 'xl', text: '336 桶', value: 336 },
];

function fmtBucket(ts, granularity) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  if (granularity >= 86400) return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (granularity >= 3600) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}时`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cellColor(max, v) {
  if (!v) return 'rgba(0,0,0,0.04)';
  const r = Math.log(1 + v) / Math.log(1 + max); // 对数色阶
  const alpha = 0.15 + 0.85 * r;
  return `rgba(34,112,215,${alpha.toFixed(2)})`;
}

export default function TokenHeatmap({ open, onClose, tokenName }) {
  const [granularity, setGranularity] = useState(3600);
  const [span, setSpan] = useState(72);
  const [points, setPoints] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    (async () => {
      setLoading(true);
      try {
        const res = await API.get(
          `/api/log/heatmap?granularity=${granularity}&span=${span}` +
            (tokenName ? `&token_name=${encodeURIComponent(tokenName)}` : '')
        );
        const { success, message, data } = res.data || {};
        if (!ignore) {
          if (success) setPoints(data.points || []);
          else showError(message || '加载失败');
        }
      } catch (e) {
        if (!ignore) showError(e.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [open, granularity, span, tokenName]);

  // 桶序列(补齐空洞) + 模型列表
  const { buckets, models, cellMap, maxCalls, totalCalls } = useMemo(() => {
    if (!points) return { buckets: [], models: [], cellMap: {}, maxCalls: 0, totalCalls: 0 };
    const endBucket = Math.floor(Date.now() / 1000 / granularity) * granularity;
    const bs = [];
    for (let i = span - 1; i >= 0; i--) bs.push(endBucket - i * granularity);
    const bset = new Set(bs);
    const ms = new Set();
    const map = {};
    let max = 0;
    let total = 0;
    for (const p of points) {
      const b = p.bucket - (p.bucket % granularity);
      if (!bset.has(b)) continue;
      ms.add(p.model);
      map[`${b}|${p.model}`] = p;
      if (p.calls > max) max = p.calls;
      total += p.calls;
    }
    const msArr = [...ms].sort((a, b) => a.localeCompare(b));
    return { buckets: bs, models: msArr, cellMap: map, maxCalls: max || 1, totalCalls: total };
  }, [points, granularity, span]);

  const labelEvery = Math.ceil(buckets.length / 14);

  return (
    <Modal open={open} onClose={onClose} size='large' closeIcon>
      <Header content={`调用热力图 — ${tokenName || '全部令牌'}（共 ${totalCalls} 次）`} />
      <Modal.Content scrolling>
        <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>粒度：</span>
          <Dropdown
            selection
            compact
            options={GRAN_OPTIONS}
            value={granularity}
            onChange={(e, { value }) => setGranularity(value)}
          />
          <span>范围：</span>
          <Dropdown
            selection
            compact
            options={SPAN_OPTIONS}
            value={span}
            onChange={(e, { value }) => setSpan(value)}
          />
          <span style={{ color: '#888', fontSize: 12 }}>
            色深 = 调用次数（对数）；悬停看详情
          </span>
        </div>
        {loading || !points ? (
          <Dimmer active inverted>
            <Loader>加载中</Loader>
          </Dimmer>
        ) : models.length === 0 ? (
          <p>该范围内没有调用记录</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                borderCollapse: 'separate',
                borderSpacing: 2,
                fontSize: 11,
                whiteSpace: 'nowrap',
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      position: 'sticky',
                      left: 0,
                      background: '#fff',
                      textAlign: 'left',
                      paddingRight: 6,
                      maxWidth: 190,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    模型
                  </th>
                  {buckets.map((b, i) => (
                    <th key={b} style={{ fontWeight: 400, color: '#999' }}>
                      {i % labelEvery === 0 ? fmtBucket(b, granularity) : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m}>
                    <td
                      title={m}
                      style={{
                        position: 'sticky',
                        left: 0,
                        background: '#fff',
                        maxWidth: 190,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textAlign: 'left',
                        paddingRight: 6,
                      }}
                    >
                      {m}
                    </td>
                    {buckets.map((b) => {
                      const p = cellMap[`${b}|${m}`];
                      const calls = p ? p.calls : 0;
                      return (
                        <td
                          key={`${b}|${m}`}
                          title={`${m} @ ${fmtBucket(b, granularity)}\n调用 ${calls} 次，消耗 ${
                            p ? p.quota : 0
                          } quota`}
                          style={{
                            background: cellColor(maxCalls, calls),
                            minWidth: 14,
                            height: 16,
                            borderRadius: 2,
                            padding: 0,
                          }}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={onClose}>关闭</Button>
      </Modal.Actions>
    </Modal>
  );
}
