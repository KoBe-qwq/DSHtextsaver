window.__ModuleLoader__.load({
  id: 'dsh-context-pack',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const zh = String(navigator.language || '').toLowerCase().startsWith('zh')
    const t = (zhText, enText) => (zh ? zhText : enText)

    async function exportSession(sessionId, displayTitle) {
      const query = new URLSearchParams({ sessionId, displayTitle: displayTitle || '' })
      const response = await fetch(`/api/context-pack.export?${query}`)
      if (!response.ok) throw new Error(await response.text())
      const blob = await response.blob()
      const filename = filenameOf(response.headers.get('content-disposition')) ||
        `context-pack-${String(sessionId).replace(/^session-/, '').slice(0, 8)}.dshpack`
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(blob)
      anchor.download = filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000)
    }

    function filenameOf(header) {
      if (!header) return undefined
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
      if (utf8) {
        try {
          return decodeURIComponent(utf8[1])
        } catch {
          return utf8[1]
        }
      }
      const plain = /filename="([^"]+)"/i.exec(header)
      return plain ? plain[1] : undefined
    }

    function pickFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.dshpack,application/octet-stream'
        input.style.display = 'none'
        const done = (file) => {
          input.remove()
          resolve(file)
        }
        input.addEventListener('change', () => done(input.files && input.files[0] ? input.files[0] : undefined), { once: true })
        input.addEventListener('cancel', () => done(undefined), { once: true })
        document.body.appendChild(input)
        input.click()
      })
    }

    async function importSession(ctx, workspaceId) {
      const file = await pickFile()
      if (file === undefined) return
      const query = new URLSearchParams({ workspaceId })
      const response = await fetch(`/api/context-pack.import?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const text = await response.text()
      let result
      try {
        result = JSON.parse(text)
      } catch {
        result = undefined
      }
      if (!response.ok) {
        throw new Error(result?.error ?? result?.message ?? text ?? `HTTP ${response.status}`)
      }
      if (!result || typeof result.sessionId !== 'string') throw new Error(t('导入响应无效', 'invalid import response'))
      const sessionId = result.sessionId
      try {
        const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx.uiWorkspace
        if (!uiWorkspace) throw new Error('uiWorkspace is unavailable')
        uiWorkspace.openSession(sessionId)
      } catch {
        const reload = window.confirm(t(
          `已导入会话 ${sessionId}。是否立即刷新页面以在左侧会话列表中打开它？`,
          `Imported session ${sessionId}. Reload now to open it from the sidebar?`,
        ))
        if (reload) window.location.reload()
      }
      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        console.info('[context-pack] import warnings', result.warnings)
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.contextMenus.register({
        id: 'context-pack:session',
        target: 'session',
        order: 400,
        resolve: ({ sessionId, displayTitle }) => [{
          id: 'context-pack:export',
          label: t('打包为上下文包', 'Package as context pack'),
          failureLabel: t('打包失败', 'Packaging failed'),
          run: () => exportSession(sessionId, displayTitle),
        }],
      }), 'context-pack: session menu')

      ctx.effect(() => ctx.contextMenus.register({
        id: 'context-pack:workspace',
        target: 'workspace',
        order: 600,
        resolve: ({ workspaceId }) => [{
          id: 'context-pack:import',
          label: t('导入上下文包…', 'Import context pack…'),
          failureLabel: t('导入失败', 'Import failed'),
          run: () => importSession(ctx, workspaceId),
        }],
      }), 'context-pack: workspace menu')
    }

    exports.apply = apply
    exports.inject = ['contextMenus', 'uiWorkspace']
    return module.exports
  },
})
