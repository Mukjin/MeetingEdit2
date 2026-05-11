import { useState, useRef, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_BACKEND_URL || ''

// ── Utility ───────────────────────────────────────────────────────────────────

function fmtTime(s) {
  if (!s && s !== 0) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function fmtSec(s) {
  if (!s && s !== 0) return ''
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1)
  return `${m}분 ${sec}초`
}

async function poll(jobId, onStatus, intervalMs = 2000) {
  return new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${API}/api/jobs/${jobId}`)
        const d = await r.json()
        onStatus(d)
        if (d.status === 'done') { clearInterval(iv); resolve(d) }
        if (d.status === 'error') { clearInterval(iv); reject(new Error(d.message)) }
      } catch (e) { clearInterval(iv); reject(e) }
    }, intervalMs)
  })
}

// ── Step indicator ────────────────────────────────────────────────────────────

function Steps({ current }) {
  const steps = ['영상 선택', '트랜스크립션', 'EDL 편집', '렌더 & 결과']
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={i} className="flex items-center">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
              active ? 'bg-orange-500 text-white' :
              done ? 'bg-zinc-700 text-zinc-300' : 'bg-zinc-900 text-zinc-600'
            }`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                active ? 'bg-white text-orange-500' :
                done ? 'bg-zinc-500 text-white' : 'bg-zinc-800 text-zinc-600'
              }`}>
                {done ? '✓' : i + 1}
              </span>
              {label}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-8 h-0.5 mx-1 ${i < current ? 'bg-zinc-600' : 'bg-zinc-800'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Video Select ──────────────────────────────────────────────────────

function Step1VideoSelect({ onNext }) {
  const [path, setPath] = useState('')
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function loadVideo() {
    setError(''); setInfo(null); setLoading(true)
    try {
      const r = await fetch(`${API}/api/video/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path.trim() })
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      const d = await r.json()
      setInfo(d)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold mb-6 text-white">영상 선택</h2>

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500"
          placeholder="/Users/.../0424_Test.mp4"
          value={path}
          onChange={e => setPath(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadVideo()}
        />
        <button
          onClick={loadVideo}
          disabled={!path.trim() || loading}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded font-medium transition-colors"
        >
          {loading ? '확인 중...' : '불러오기'}
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {info && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-2">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
            <span className="text-zinc-500">파일</span>
            <span className="text-white font-mono truncate">{info.stem}.mp4</span>
            <span className="text-zinc-500">길이</span>
            <span className="text-white">{info.duration_fmt}</span>
            <span className="text-zinc-500">해상도</span>
            <span className="text-white">{info.width}×{info.height} @ {info.fps}fps</span>
            <span className="text-zinc-500">크기</span>
            <span className="text-white">{info.size_mb} MB</span>
            <span className="text-zinc-500">편집 폴더</span>
            <span className="text-zinc-400 font-mono text-xs truncate">{info.edit_dir}</span>
          </div>
        </div>
      )}

      {info && (
        <button
          onClick={() => onNext(info)}
          className="px-6 py-2 bg-orange-500 hover:bg-orange-400 text-white font-medium rounded transition-colors"
        >
          다음: 트랜스크립션 →
        </button>
      )}
    </div>
  )
}

// ── Step 2: Transcription ─────────────────────────────────────────────────────

function Step2Transcribe({ videoInfo, onNext, onBack }) {
  const [status, setStatus] = useState(null)
  const [jobMsg, setJobMsg] = useState('')
  const [transcript, setTranscript] = useState(null)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [transcriptPath, setTranscriptPath] = useState('')
  const [search, setSearch] = useState('')

  async function startTranscribe() {
    setRunning(true); setDone(false)
    try {
      const r = await fetch(`${API}/api/transcribe/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_path: videoInfo.path, edit_dir: videoInfo.edit_dir })
      })
      const { job_id } = await r.json()
      const result = await poll(job_id, d => setJobMsg(d.message), 3000)
      setTranscriptPath(result.result)
      const tr = await fetch(`${API}/api/transcript?path=${encodeURIComponent(result.result)}`)
      setTranscript(await tr.json())
      setDone(true)
    } catch (e) { setJobMsg('오류: ' + e.message) }
    finally { setRunning(false) }
  }

  const words = transcript?.words || []
  const filtered = search
    ? words.filter(w => w.text.includes(search))
    : words

  // Group words into lines (by ~10 words)
  const lines = []
  for (let i = 0; i < filtered.length; i += 12) {
    const chunk = filtered.slice(i, i + 12)
    lines.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map(w => w.text).join(' ')
    })
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-semibold mb-2 text-white">트랜스크립션</h2>
      <p className="text-zinc-500 text-sm mb-6">mlx-whisper (Apple Silicon, 무료) · 30~40분 소요</p>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-4 text-sm">
        <div className="flex justify-between items-start">
          <div>
            <p className="text-zinc-400">{videoInfo.stem}.mp4 · {videoInfo.duration_fmt}</p>
            <p className="text-zinc-600 text-xs mt-1">{videoInfo.edit_dir}</p>
          </div>
          {!done && (
            <button
              onClick={startTranscribe}
              disabled={running}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded font-medium transition-colors"
            >
              {running ? '실행 중...' : '트랜스크립션 시작'}
            </button>
          )}
        </div>
        {(running || jobMsg) && (
          <div className="mt-3 flex items-center gap-2">
            {running && <div className="w-3 h-3 rounded-full bg-orange-500 animate-pulse" />}
            <span className={`text-sm ${done ? 'text-green-400' : 'text-zinc-400'}`}>{jobMsg}</span>
          </div>
        )}
      </div>

      {transcript && (
        <>
          <div className="flex gap-2 mb-3">
            <input
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500"
              placeholder="검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span className="text-zinc-500 text-sm flex items-center px-2">
              {words.length.toLocaleString()} 단어
            </span>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-auto max-h-80 text-sm">
            {lines.map((line, i) => (
              <div key={i} className="flex gap-3 px-3 py-1.5 hover:bg-zinc-800 border-b border-zinc-800/50">
                <span className="text-zinc-600 font-mono text-xs w-20 shrink-0 pt-0.5">
                  {fmtTime(line.start)}
                </span>
                <span className="text-zinc-300 leading-relaxed">{line.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex gap-3 mt-6">
        <button onClick={onBack} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded transition-colors">
          ← 이전
        </button>
        {done && (
          <button
            onClick={() => onNext({ ...videoInfo, transcriptPath })}
            className="px-6 py-2 bg-orange-500 hover:bg-orange-400 text-white font-medium rounded transition-colors"
          >
            다음: EDL 편집 →
          </button>
        )}
      </div>
    </div>
  )
}

// ── Step 3: EDL Editor ────────────────────────────────────────────────────────

const PRESET_COLORS = {
  'presenter-1': '#3b82f6',
  'presenter-2': '#10b981',
  'presenter-3': '#f59e0b',
  'presenter-4': '#ec4899',
  'presenter-5': '#8b5cf6',
  'presenter-6': '#06b6d4',
}

function presenterColor(name, names) {
  const idx = names.indexOf(name)
  const colors = Object.values(PRESET_COLORS)
  return colors[idx % colors.length] || '#888'
}

// 영상 위 자막 오버레이 (CSS, 실시간)
function SubtitleOverlay({ cues, videoTime }) {
  if (!cues) return null
  const active = cues.find(c => videoTime >= c.start && videoTime < c.end)
  if (!active) return null
  return (
    <div className="absolute bottom-12 left-0 right-0 flex justify-center pointer-events-none px-4">
      <div
        style={{
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '1.15rem',
          fontWeight: 'bold',
          color: '#fff',
          textShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000',
          textAlign: 'center',
          lineHeight: 1.3,
          maxWidth: '85%',
        }}
      >
        {active.text}
      </div>
    </div>
  )
}

function SubtitleEditor({ editDir, transcriptPath, onSaved, videoRef, videoTime, cues, setCues }) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [editingIdx, setEditingIdx] = useState(null)
  const [editText, setEditText] = useState('')
  const activeCueRef = useRef(null)

  const activeIdx = cues
    ? cues.findIndex(c => videoTime >= c.start && videoTime < c.end)
    : -1

  useEffect(() => {
    if (activeCueRef.current) {
      activeCueRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeIdx])

  async function generate() {
    setLoading(true); setMsg('')
    try {
      const r = await fetch(`${API}/api/subtitles/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_dir: editDir, edl: {} })
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      const d = await r.json()
      setCues(d.cues)
      setMsg(`${d.cues.length}개 자막 생성됨`)
    } catch (e) { setMsg('오류: ' + e.message) }
    finally { setLoading(false) }
  }

  async function save() {
    if (!cues) return
    setSaving(true); setMsg('')
    try {
      const r = await fetch(`${API}/api/subtitles/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_dir: editDir, cues })
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      const d = await r.json()
      setMsg(`저장 완료 (${d.count}개)`)
      onSaved(true)
    } catch (e) { setMsg('오류: ' + e.message) }
    finally { setSaving(false) }
  }

  async function remove() {
    await fetch(`${API}/api/subtitles?edit_dir=${encodeURIComponent(editDir)}`, { method: 'DELETE' })
    setCues(null); setMsg('자막 제거됨'); onSaved(false)
  }

  function seekTo(t) {
    if (videoRef?.current) { videoRef.current.currentTime = t; videoRef.current.play() }
  }

  function commitEdit(i) {
    const next = [...cues]
    next[i] = { ...next[i], text: editText }
    setCues(next); setEditingIdx(null)
  }

  function updateTime(i, field, val) {
    const n = parseFloat(val)
    if (isNaN(n)) return
    const next = [...cues]
    next[i] = { ...next[i], [field]: n }
    setCues(next)
  }

  function deleteCue(i) {
    const next = cues.filter((_, idx) => idx !== i).map((c, idx) => ({ ...c, index: idx + 1 }))
    setCues(next)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0">
        <button
          onClick={generate}
          disabled={loading || !transcriptPath}
          className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded font-medium transition-colors"
        >
          {loading ? '생성 중...' : cues ? '재생성' : '자막 생성'}
        </button>
        {cues && (
          <>
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 text-xs bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 text-white rounded font-medium transition-colors"
            >
              {saving ? '저장 중...' : '저장'}
            </button>
            <button
              onClick={remove}
              className="px-3 py-1.5 text-xs bg-red-900/40 hover:bg-red-900/70 text-red-400 rounded transition-colors"
            >
              자막 제거
            </button>
          </>
        )}
        {msg && (
          <span className={`text-xs ml-1 ${msg.startsWith('오류') ? 'text-red-400' : 'text-zinc-400'}`}>
            {msg}
          </span>
        )}
        {!transcriptPath && (
          <span className="text-xs text-zinc-600 ml-1">트랜스크립션 먼저 실행하세요</span>
        )}
      </div>

      {/* Cue list */}
      {!cues && !loading && (
        <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm border border-zinc-800 rounded-lg">
          EDL 저장 후 "자막 생성" 버튼을 눌러 자막을 만드세요
        </div>
      )}

      {cues && (
        <div className="flex-1 overflow-auto bg-zinc-900 border border-zinc-800 rounded-lg">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-900/95 border-b border-zinc-800 z-10">
              <tr className="text-zinc-500">
                <th className="text-left px-3 py-2 w-8">#</th>
                <th className="text-left px-3 py-2 w-24">시작</th>
                <th className="text-left px-3 py-2 w-24">종료</th>
                <th className="text-left px-3 py-2">자막 텍스트</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {cues.map((c, i) => {
                const isActive = i === activeIdx
                return (
                  <tr
                    key={i}
                    ref={isActive ? activeCueRef : null}
                    className={`border-b border-zinc-800/50 transition-colors ${
                      isActive ? 'bg-orange-500/15 border-l-2 border-l-orange-500' : 'hover:bg-zinc-800/30'
                    }`}
                  >
                    <td
                      className="px-3 py-2 text-zinc-600 cursor-pointer hover:text-orange-400 transition-colors"
                      onClick={() => seekTo(c.start)}
                      title="클릭하여 이 자막으로 이동"
                    >
                      {c.index}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        className="w-full bg-transparent font-mono text-zinc-500 focus:text-white focus:outline-none focus:bg-zinc-800 rounded px-1 text-xs"
                        value={c.start.toFixed(2)}
                        onChange={e => updateTime(i, 'start', e.target.value)}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        className="w-full bg-transparent font-mono text-zinc-500 focus:text-white focus:outline-none focus:bg-zinc-800 rounded px-1 text-xs"
                        value={c.end.toFixed(2)}
                        onChange={e => updateTime(i, 'end', e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {editingIdx === i ? (
                        <input
                          autoFocus
                          className="w-full bg-zinc-800 border border-orange-500 rounded px-2 py-0.5 text-white focus:outline-none text-xs"
                          value={editText}
                          onChange={e => setEditText(e.target.value)}
                          onBlur={() => commitEdit(i)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitEdit(i)
                            if (e.key === 'Escape') setEditingIdx(null)
                          }}
                        />
                      ) : (
                        <span
                          className={`cursor-text hover:text-white transition-colors ${isActive ? 'text-white font-medium' : 'text-zinc-300'}`}
                          onClick={() => { setEditingIdx(i); setEditText(c.text) }}
                        >
                          {c.text}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <button
                        onClick={() => deleteCue(i)}
                        className="text-zinc-700 hover:text-red-400 transition-colors"
                      >✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PresenterTranscript({ presenterNames, ranges, words, videoTime, currentPresenter, seekTo, presenterColor }) {
  const [activeTab, setActiveTab] = useState(null)
  const activeLineRef = useRef(null)

  // 현재 재생 중인 발표자로 탭 자동 전환
  useEffect(() => {
    if (currentPresenter && currentPresenter !== activeTab) {
      setActiveTab(currentPresenter)
    }
  }, [currentPresenter])

  // 탭이 없으면 첫 번째 발표자로 초기화
  useEffect(() => {
    if (!activeTab && presenterNames.length > 0) setActiveTab(presenterNames[0])
  }, [presenterNames])

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [videoTime, activeTab])

  if (presenterNames.length === 0 || words.length === 0) {
    return (
      <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-center text-zinc-600 text-xs">
        {words.length === 0 ? '트랜스크립션 완료 후 표시됩니다' : 'AI 분석 후 발표자별로 표시됩니다'}
      </div>
    )
  }

  // 선택된 발표자의 구간들
  const presenterRanges = ranges.filter(r => r.beat === activeTab)

  // 해당 구간에 속하는 단어만 추출 (구간별로 묶어서)
  const segments = presenterRanges.map(r => {
    const segWords = words.filter(w => w.start >= r.start && w.end <= r.end + 0.1)
    return { range: r, words: segWords }
  }).filter(s => s.words.length > 0)

  // 단어를 6개씩 줄로 묶기
  const lines = []
  for (const seg of segments) {
    for (let i = 0; i < seg.words.length; i += 8) {
      const chunk = seg.words.slice(i, i + 8)
      lines.push({
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        text: chunk.map(w => w.text).join(' '),
        words: chunk,
      })
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      {/* 발표자 탭 */}
      <div className="flex border-b border-zinc-800 flex-shrink-0 overflow-x-auto">
        {presenterNames.map(name => {
          const color = presenterColor(name)
          const isActive = activeTab === name
          const isCurrent = currentPresenter === name
          return (
            <button
              key={name}
              onClick={() => setActiveTab(name)}
              className={`px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 border-b-2 -mb-px ${
                isActive ? 'text-white border-b-2' : 'text-zinc-500 hover:text-zinc-300 border-transparent'
              }`}
              style={{ borderBottomColor: isActive ? color : 'transparent' }}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              {name}
              {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />}
            </button>
          )
        })}
      </div>

      {/* 트랜스크립트 */}
      <div className="flex-1 overflow-auto text-xs p-1">
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600">이 발표자의 구간이 없습니다</div>
        ) : (
          lines.map((line, i) => {
            const isActive = videoTime >= line.start && videoTime <= line.end
            return (
              <div
                key={i}
                ref={isActive ? activeLineRef : null}
                className={`flex gap-2 px-2 py-1 rounded cursor-pointer transition-colors ${
                  isActive ? 'bg-orange-500/20 text-white' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
                onClick={() => seekTo(line.start)}
              >
                <span className="font-mono text-zinc-600 shrink-0 w-12 text-right">{fmtTime(line.start)}</span>
                <span className={isActive ? 'text-white' : ''}>{line.text}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function Step3EDL({ videoInfo, onNext, onBack }) {
  const [transcript, setTranscript] = useState(null)
  const [ranges, setRanges] = useState([])
  const [videoTime, setVideoTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(videoInfo.duration || 0)
  const [newRange, setNewRange] = useState({ start: '', end: '', beat: '', quote: '', reason: '' })
  const [editIdx, setEditIdx] = useState(null)
  const [saved, setSaved] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeMsg, setAnalyzeMsg] = useState('')
  const [editMode, setEditMode] = useState('full')
  const [rightTab, setRightTab] = useState('edl')
  const [hasSubs, setHasSubs] = useState(false)
  const [subCues, setSubCues] = useState(null)
  const videoRef = useRef(null)

  useEffect(() => {
    if (videoInfo.transcriptPath) {
      fetch(`${API}/api/transcript?path=${encodeURIComponent(videoInfo.transcriptPath)}`)
        .then(r => r.json()).then(setTranscript)
    }
    fetch(`${API}/api/files/list?dir=${encodeURIComponent(videoInfo.edit_dir)}`)
      .then(r => r.json()).then(d => {
        const edlFile = d.files?.find(f => f.name === 'edl.json')
        if (edlFile) {
          fetch(`${API}/api/transcript?path=${encodeURIComponent(edlFile.path)}`)
            .then(r => r.json()).then(edl => {
              if (edl.ranges) setRanges(edl.ranges)
              if (edl.subtitles) setHasSubs(true)
            }).catch(() => {})
        }
      })
  }, [])

  async function autoAnalyze() {
    setAnalyzing(true); setAnalyzeMsg('')
    try {
      const r = await fetch(`${API}/api/analyze/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edit_dir: videoInfo.edit_dir,
          video_path: videoInfo.path,
          transcript_path: videoInfo.transcriptPath,
          mode: editMode,
        })
      })
      const { job_id } = await r.json()
      const res = await poll(job_id, d => setAnalyzeMsg(d.message), 3000)
      setRanges(res.result)
      setSaved(false)
    } catch (e) { setAnalyzeMsg('오류: ' + e.message) }
    finally { setAnalyzing(false) }
  }

  const words = transcript?.words || []
  const presenterNames = [...new Set(ranges.map(r => r.beat).filter(Boolean))]

  function seekTo(t) {
    if (videoRef.current) { videoRef.current.currentTime = t; videoRef.current.play() }
  }

  function addRange() {
    const s = parseFloat(newRange.start)
    const e = parseFloat(newRange.end)
    if (isNaN(s) || isNaN(e) || e <= s) return
    const r = { source: videoInfo.stem, start: s, end: e,
      beat: newRange.beat, quote: newRange.quote, reason: newRange.reason }
    if (editIdx !== null) {
      const arr = [...ranges]; arr[editIdx] = r; setRanges(arr); setEditIdx(null)
    } else {
      setRanges(prev => [...prev, r].sort((a, b) => a.start - b.start))
    }
    setNewRange({ start: '', end: '', beat: '', quote: '', reason: '' })
    setSaved(false)
  }

  function removeRange(i) {
    setRanges(prev => prev.filter((_, idx) => idx !== i))
    setSaved(false)
  }

  function editRange(i) {
    const r = ranges[i]
    setNewRange({ start: String(r.start), end: String(r.end),
      beat: r.beat || '', quote: r.quote || '', reason: r.reason || '' })
    setEditIdx(i)
  }

  function setMarkIn() {
    setNewRange(p => ({ ...p, start: videoRef.current?.currentTime?.toFixed(2) || '' }))
  }
  function setMarkOut() {
    setNewRange(p => ({ ...p, end: videoRef.current?.currentTime?.toFixed(2) || '' }))
  }

  async function saveEDL() {
    const edl = {
      version: 1,
      sources: { [videoInfo.stem]: videoInfo.path },
      ranges,
      grade: 'none',
      subtitles: null,
      total_duration_s: ranges.reduce((s, r) => s + (r.end - r.start), 0)
    }
    await fetch(`${API}/api/edl/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_dir: videoInfo.edit_dir, edl })
    })
    setSaved(true)
  }

  const totalSecs = ranges.reduce((s, r) => s + (r.end - r.start), 0)
  const videoSrc = `${API}/api/video/stream?path=${encodeURIComponent(videoInfo.path)}`

  function rangeStyle(r) {
    const left = (r.start / videoDuration) * 100
    const width = ((r.end - r.start) / videoDuration) * 100
    const color = presenterColor(r.beat, presenterNames)
    return { left: `${left}%`, width: `${Math.max(width, 0.2)}%`, backgroundColor: color }
  }

  // 현재 재생 시간이 속한 발표자
  const currentPresenter = ranges.find(r => videoTime >= r.start && videoTime <= r.end)?.beat || null

  // ── 공통 탭바 + 하단 버튼 ──────────────────────────────────────────────────

  const tabBar = (
    <div className="flex items-center justify-between mb-3 flex-shrink-0">
      <div className="flex border-b border-zinc-800">
        {[
          { key: 'edl', label: 'EDL 편집' },
          { key: 'subs', label: `자막${hasSubs ? ' ✓' : ''}` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setRightTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              rightTab === t.key
                ? 'border-orange-500 text-orange-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {rightTab === 'edl' && (
        <div className="flex gap-2">
          <div className="flex rounded overflow-hidden border border-zinc-700 text-xs">
            {[{ key: 'full', label: '전체 편집' }, { key: 'shorts', label: '⚡ 쇼츠' }].map(m => (
              <button key={m.key} onClick={() => setEditMode(m.key)}
                className={`px-3 py-1.5 font-medium transition-colors ${editMode === m.key ? 'bg-orange-500 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
                {m.label}
              </button>
            ))}
          </div>
          <button onClick={autoAnalyze} disabled={analyzing || !videoInfo.transcriptPath}
            className="flex items-center gap-2 px-4 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded font-medium transition-colors">
            {analyzing ? <><span className="w-3 h-3 rounded-full bg-white/60 animate-pulse" />분석 중...</> : <>✦ AI 분석</>}
          </button>
          <button onClick={saveEDL} disabled={ranges.length === 0}
            className="px-4 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded transition-colors">
            {saved ? '✓ 저장됨' : 'EDL 저장'}
          </button>
        </div>
      )}
    </div>
  )

  const bottomBar = (
    <div className="flex gap-3 mt-4 items-center flex-shrink-0">
      <button onClick={onBack} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded transition-colors">
        ← 이전
      </button>
      <button
        onClick={async () => { await saveEDL(); onNext(videoInfo) }}
        disabled={ranges.length === 0}
        className="px-6 py-2 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-medium rounded transition-colors"
      >
        저장 후 렌더 →
      </button>
      {hasSubs && <span className="text-xs text-orange-400 ml-1">자막 포함하여 렌더됩니다</span>}
      {ranges.length > 0 && (
        <span className="text-xs text-zinc-600 ml-auto">{ranges.length}개 클립 · {fmtSec(totalSecs)}</span>
      )}
    </div>
  )

  // ── 자막 탭: 영상 크게 + 오버레이 자막 + 우측 목록 ─────────────────────────

  if (rightTab === 'subs') {
    return (
      <div className="flex flex-col h-[calc(100vh-160px)] min-h-0">
        {tabBar}
        <div className="flex gap-5 flex-1 min-h-0">
          {/* 영상 + 자막 오버레이 */}
          <div className="flex flex-col gap-2 w-[52%] shrink-0">
            <div className="relative rounded-lg overflow-hidden bg-black">
              <video
                ref={videoRef}
                src={videoSrc}
                className="w-full aspect-video"
                controls
                onTimeUpdate={e => setVideoTime(e.target.currentTime)}
                onLoadedMetadata={e => setVideoDuration(e.target.duration)}
              />
              {/* 자막 오버레이 */}
              <SubtitleOverlay cues={subCues} videoTime={videoTime} />
            </div>
            {/* 타임라인 */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2">
              <div className="relative h-5 bg-zinc-800 rounded overflow-hidden mb-1">
                {ranges.map((r, i) => (
                  <div key={i} className="absolute h-full opacity-70" style={rangeStyle(r)} />
                ))}
                <div className="absolute top-0 w-0.5 h-full bg-white/70 pointer-events-none"
                  style={{ left: `${(videoTime / videoDuration) * 100}%` }} />
              </div>
              <div className="flex justify-between text-xs text-zinc-600">
                <span>{fmtTime(0)}</span>
                <span className="text-orange-400">{fmtTime(videoTime)}</span>
                <span>{fmtTime(videoDuration)}</span>
              </div>
            </div>
          </div>

          {/* 자막 목록 */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <SubtitleEditor
              editDir={videoInfo.edit_dir}
              transcriptPath={videoInfo.transcriptPath}
              onSaved={setHasSubs}
              videoRef={videoRef}
              videoTime={videoTime}
              cues={subCues}
              setCues={setSubCues}
            />
          </div>
        </div>
        {bottomBar}
      </div>
    )
  }

  // ── EDL 탭: 기존 레이아웃 ──────────────────────────────────────────────────

  return (
    <div className="flex gap-6 h-[calc(100vh-200px)] min-h-0">
      {/* Left: video + timeline + transcript tabs + mark in/out */}
      <div className="flex flex-col gap-2 w-96 shrink-0 min-h-0 overflow-hidden">
        <video
          ref={videoRef}
          src={videoSrc}
          className="w-full rounded-lg bg-black aspect-video"
          controls
          onTimeUpdate={e => setVideoTime(e.target.currentTime)}
          onLoadedMetadata={e => setVideoDuration(e.target.duration)}
        />
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="relative h-6 bg-zinc-800 rounded overflow-hidden mb-1">
            {ranges.map((r, i) => (
              <div key={i} className="absolute h-full opacity-80 cursor-pointer hover:opacity-100 transition-opacity"
                style={rangeStyle(r)} onClick={() => seekTo(r.start)}
                title={`${r.beat}: ${fmtTime(r.start)} - ${fmtTime(r.end)}`} />
            ))}
            <div className="absolute top-0 w-0.5 h-full bg-white/70 pointer-events-none"
              style={{ left: `${(videoTime / videoDuration) * 100}%` }} />
          </div>
          <div className="flex justify-between text-xs text-zinc-600">
            <span>{fmtTime(0)}</span>
            <span className="text-orange-400">{fmtTime(videoTime)}</span>
            <span>{fmtTime(videoDuration)}</span>
          </div>
        </div>

        {/* 발표자별 트랜스크립트 탭 */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <PresenterTranscript
            presenterNames={presenterNames}
            ranges={ranges}
            words={words}
            videoTime={videoTime}
            currentPresenter={currentPresenter}
            seekTo={seekTo}
            presenterColor={(name) => presenterColor(name, presenterNames)}
          />
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2 shrink-0">
          <p className="text-xs text-zinc-500 font-medium">새 구간 추가</p>
          <div className="flex gap-2">
            <button onClick={setMarkIn} className="flex-1 text-xs py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300">
              ← 시작 [{fmtTime(parseFloat(newRange.start) || 0)}]
            </button>
            <button onClick={setMarkOut} className="flex-1 text-xs py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300">
              종료 → [{fmtTime(parseFloat(newRange.end) || 0)}]
            </button>
          </div>
          <input className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white placeholder-zinc-600"
            placeholder="발표자 이름" value={newRange.beat}
            onChange={e => setNewRange(p => ({ ...p, beat: e.target.value }))} />
          <input className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white placeholder-zinc-600"
            placeholder="대표 발언 (quote)" value={newRange.quote}
            onChange={e => setNewRange(p => ({ ...p, quote: e.target.value }))} />
          <input className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white placeholder-zinc-600"
            placeholder="포함 이유 (reason)" value={newRange.reason}
            onChange={e => setNewRange(p => ({ ...p, reason: e.target.value }))} />
          <button onClick={addRange} disabled={!newRange.start || !newRange.end || !newRange.beat}
            className="w-full py-1.5 text-xs bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded font-medium">
            {editIdx !== null ? '수정 저장' : '+ 구간 추가'}
          </button>
        </div>
      </div>

      {/* Right: EDL */}
      <div className="flex-1 flex flex-col min-w-0">
        {tabBar}
        {analyzeMsg && (
          <p className={`text-xs mb-2 ${analyzeMsg.startsWith('오류') ? 'text-red-400' : 'text-zinc-500'}`}>{analyzeMsg}</p>
        )}
        <div className="flex-1 overflow-auto bg-zinc-900 border border-zinc-800 rounded-lg">
          {ranges.length === 0 ? (
            <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
              왼쪽 영상에서 구간을 선택해 추가하거나 AI 분석을 실행하세요
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-900/95 border-b border-zinc-800">
                <tr className="text-zinc-500">
                  <th className="text-left px-3 py-2 w-8">#</th>
                  <th className="text-left px-3 py-2">발표자</th>
                  <th className="text-left px-3 py-2 w-20">시작</th>
                  <th className="text-left px-3 py-2 w-20">종료</th>
                  <th className="text-left px-3 py-2 w-16">길이</th>
                  <th className="text-left px-3 py-2">발언/이유</th>
                  <th className="px-3 py-2 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {ranges.map((r, i) => (
                  <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/40 cursor-pointer"
                    onClick={() => seekTo(r.start)}>
                    <td className="px-3 py-2 text-zinc-600">{i + 1}</td>
                    <td className="px-3 py-2">
                      <span className="px-1.5 py-0.5 rounded text-white text-xs"
                        style={{ backgroundColor: presenterColor(r.beat, presenterNames) }}>
                        {r.beat}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-400">{fmtTime(r.start)}</td>
                    <td className="px-3 py-2 font-mono text-zinc-400">{fmtTime(r.end)}</td>
                    <td className="px-3 py-2 text-zinc-500">{fmtTime(r.end - r.start)}</td>
                    <td className="px-3 py-2 text-zinc-400 max-w-xs truncate">
                      {r.quote && <span className="text-zinc-300">"{r.quote}" </span>}
                      {r.reason && <span className="text-zinc-600">{r.reason}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <button onClick={() => editRange(i)}
                          className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300 text-xs">수정</button>
                        <button onClick={() => removeRange(i)}
                          className="px-2 py-0.5 bg-red-900/40 hover:bg-red-900/70 rounded text-red-400 text-xs">삭제</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {bottomBar}
      </div>
    </div>
  )
}

// ── Step 4: Render & Result ───────────────────────────────────────────────────

function Step4Render({ videoInfo, onBack }) {
  const [jobMsg, setJobMsg] = useState('')
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [result, setResult] = useState(null)
  const [report, setReport] = useState('')
  const [tab, setTab] = useState('video')

  async function startRender() {
    setRunning(true); setDone(false); setReport('')
    try {
      const r = await fetch(`${API}/api/render/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_dir: videoInfo.edit_dir, video_path: videoInfo.path })
      })
      const { job_id } = await r.json()
      const res = await poll(job_id, d => setJobMsg(d.message), 4000)
      setResult(res.result)
      // Load report
      const rr = await fetch(`${API}/api/report?path=${encodeURIComponent(res.result.report)}`)
      const rd = await rr.json()
      setReport(rd.content)
      setDone(true)
    } catch (e) { setJobMsg('오류: ' + e.message) }
    finally { setRunning(false) }
  }

  const previewSrc = result
    ? `${API}/api/video/stream?path=${encodeURIComponent(result.preview)}`
    : null

  return (
    <div className="max-w-4xl">
      <h2 className="text-xl font-semibold mb-6 text-white">렌더 & 결과</h2>

      {!done && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 mb-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <p className="text-white font-medium">{videoInfo.stem}.mp4</p>
              <p className="text-zinc-500 text-sm">{videoInfo.duration_fmt} · {videoInfo.edit_dir}</p>
            </div>
            <button
              onClick={startRender}
              disabled={running}
              className="px-6 py-2.5 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-medium rounded transition-colors"
            >
              {running ? '렌더 중...' : '렌더 시작'}
            </button>
          </div>

          {(running || jobMsg) && (
            <div className="flex items-center gap-3">
              {running && (
                <div className="flex gap-1">
                  {[0,1,2].map(i => (
                    <div key={i} className="w-2 h-2 rounded-full bg-orange-500 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              )}
              <span className={`text-sm ${done ? 'text-green-400' : 'text-zinc-400'}`}>{jobMsg}</span>
            </div>
          )}
          <p className="text-zinc-600 text-xs mt-3">
            1080p · CRF 22 · -14 LUFS 라우드니스 정규화 · 중간 파일 자동 삭제
          </p>
        </div>
      )}

      {done && result && (
        <>
          <div className="flex gap-2 mb-4 border-b border-zinc-800">
            {['video', 'report'].map(t => (
              <button key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t ? 'border-orange-500 text-orange-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}>
                {t === 'video' ? '결과 영상' : '편집 보고서'}
              </button>
            ))}
          </div>

          {tab === 'video' && (
            <div>
              <video
                src={previewSrc}
                className="w-full max-h-[60vh] rounded-lg bg-black"
                controls
                autoPlay={false}
              />
              <div className="mt-3 flex gap-4 text-sm text-zinc-500">
                <span className="text-green-400 font-medium">✓ 렌더 완료</span>
                <span>{fmtSec(result.duration)}</span>
                <span className="font-mono text-xs text-zinc-600 truncate">{result.preview}</span>
              </div>
            </div>
          )}

          {tab === 'report' && (
            <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-300 font-mono overflow-auto max-h-[60vh] whitespace-pre-wrap">
              {report}
            </pre>
          )}
        </>
      )}

      <div className="mt-6">
        <button onClick={onBack} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded transition-colors">
          ← 이전
        </button>
      </div>
    </div>
  )
}

// ── API Key Modal ─────────────────────────────────────────────────────────────

function ApiKeyModal({ onClose }) {
  const [key, setKey] = useState('')
  const [status, setStatus] = useState('')
  const [current, setCurrent] = useState('')

  useEffect(() => {
    fetch(`${API}/api/settings/apikey`).then(r => r.json()).then(d => {
      if (d.set) setCurrent(d.preview)
    })
  }, [])

  async function save() {
    setStatus('')
    try {
      const r = await fetch(`${API}/api/settings/apikey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key })
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail) }
      setStatus('저장됨')
      setCurrent(key.slice(0, 8) + '...')
      setKey('')
      setTimeout(onClose, 800)
    } catch (e) { setStatus('오류: ' + e.message) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-96" onClick={e => e.stopPropagation()}>
        <h3 className="text-white font-semibold mb-1">Anthropic API 키 설정</h3>
        <p className="text-zinc-500 text-xs mb-4">
          AI 자동 분석에 사용됩니다. 키는 backend/.env 파일에 저장됩니다.
        </p>
        {current && (
          <p className="text-zinc-400 text-xs mb-3">현재: <span className="font-mono text-zinc-300">{current}</span></p>
        )}
        <input
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500 font-mono mb-3"
          placeholder="sk-ant-..."
          value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          type="password"
          autoFocus
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded">취소</button>
          <button onClick={save} disabled={!key.trim()} className="px-4 py-1.5 text-sm bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded font-medium">
            저장
          </button>
        </div>
        {status && <p className={`text-xs mt-2 text-right ${status.startsWith('오류') ? 'text-red-400' : 'text-green-400'}`}>{status}</p>}
      </div>
    </div>
  )
}


// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState(0)
  const [videoInfo, setVideoInfo] = useState(null)
  const [showApiKey, setShowApiKey] = useState(false)

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-200">
      {showApiKey && <ApiKeyModal onClose={() => setShowApiKey(false)} />}
      <header className="border-b border-zinc-800 px-8 py-4 flex items-center gap-4">
        <div className="w-2 h-2 rounded-full bg-orange-500" />
        <h1 className="text-base font-semibold text-white tracking-tight">Meeting Edit</h1>
        <span className="text-zinc-600 text-sm">회의 녹화 자동 편집</span>
        <div className="ml-auto">
          <button
            onClick={() => setShowApiKey(true)}
            className="text-xs text-zinc-600 hover:text-zinc-400 px-3 py-1.5 rounded border border-zinc-800 hover:border-zinc-600 transition-colors"
          >
            ⚙ API 키 설정
          </button>
        </div>
      </header>

      <main className="px-8 py-8">
        <Steps current={step} />

        {step === 0 && (
          <Step1VideoSelect
            onNext={info => { setVideoInfo(info); setStep(1) }}
          />
        )}
        {step === 1 && videoInfo && (
          <Step2Transcribe
            videoInfo={videoInfo}
            onNext={info => { setVideoInfo(info); setStep(2) }}
            onBack={() => setStep(0)}
          />
        )}
        {step === 2 && videoInfo && (
          <Step3EDL
            videoInfo={videoInfo}
            onNext={info => { setVideoInfo(info); setStep(3) }}
            onBack={() => setStep(1)}
          />
        )}
        {step === 3 && videoInfo && (
          <Step4Render
            videoInfo={videoInfo}
            onBack={() => setStep(2)}
          />
        )}
      </main>
    </div>
  )
}
