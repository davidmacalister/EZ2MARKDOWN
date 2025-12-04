(function(){
	// depende de markdown-it e turndown (carregados no HTML)
	// Alterado: breaks:true para considerar \n como quebra de linha visual (comportamento contínuo)
	const md = window.markdownit({html:true,linkify:true, breaks:true});
	const td = new window.TurndownService();
	td.keep(['audio', 'video', 'source', 'br']); // Manter tags de áudio/vídeo e quebras de linha ao converter HTML->MD

	// estado
	let allFiles = new Map();
	let mdFiles = new Map();
	let objectUrlMap = new Map();
	let expandedPaths = new Set(); // <-- novo: persistir estado de pastas
	let currentName = 'untitled.md';
	let currentTableIdx = null;
	let currentTableRowIdx = null;
	let currentTableColIdx = null; // <-- novo: coluna atualmente clicada
	let lastSidebarWidth = null;
	let persistentFileHandle = null;
	let isReorderMode = false; // <-- novo: estado do modo de reordenação
	let isAudioEnabled = true; // <-- novo: estado dos players de áudio
	// info temporário de drag (blockIdx, rowIdx)
	let __dragInfo = null;
	
	// Undo/Redo
	const undoStack = [];
	const redoStack = [];
	const MAX_HISTORY = 50;

	function saveState(){
		const current = $('editor').value;
		if(undoStack.length > 0 && undoStack[undoStack.length-1] === current) return;
		undoStack.push(current);
		if(undoStack.length > MAX_HISTORY) undoStack.shift();
		redoStack.length = 0;
	}

	function undo(){
		if(undoStack.length === 0) return;
		const current = $('editor').value;
		redoStack.push(current);
		const prev = undoStack.pop();
		$('editor').value = prev;
		renderPreviewFrom(prev);
	}

	function redo(){
		if(redoStack.length === 0) return;
		const current = $('editor').value;
		undoStack.push(current);
		const next = redoStack.pop();
		$('editor').value = next;
		renderPreviewFrom(next);
	}

	// GitHub integration state
	let gitHubRepoData = null; // { owner, repo, branch }
	let gitHubToken = localStorage.getItem('ez2_gh_token') || null; // <-- novo: token persistido

	// Helper para fetch autenticado no GitHub
	async function ghFetch(url, opts = {}) {
		const headers = opts.headers || {};
		if (gitHubToken) {
			headers['Authorization'] = `Bearer ${gitHubToken}`;
		}
		// Se não for raw content explícito, pedir JSON v3
		if (!headers['Accept']) {
			headers['Accept'] = 'application/vnd.github.v3+json';
		}
		return fetch(url, { ...opts, headers });
	}

	// ConnectionManager centraliza ping, pickFolder, save e fallback HTTPS
	class ConnectionManager {
		constructor(origin, opts = {}) {
			this.origin = origin;
			this.base = null;
			this.available = false;
			this._pingIntervalMs = opts.pingIntervalMs || 4000;
			this._timer = null;
			this._triedHttps = false;
			this._lastLatency = null;
			this._running = null; // novo: estado running vindo do /info
		}
		async _fetch(url, init) {
			const start = performance.now();
			const res = await fetch(url, Object.assign({ mode: 'cors', cache: 'no-cache' }, init));
			this._lastLatency = Math.round(performance.now() - start);
			return res;
		}
		async ping() {
			try {
				const res = await this._fetch(this.origin + '/ping', { method: 'GET' });
				if (!res.ok) throw new Error('HTTP ' + res.status);
				const j = await res.json().catch(() => null);
				this.available = !!(j && j.ok);
				return this.available;
			} catch (err) {
				// tentar fallback HTTPS uma única vez
				if (!this._triedHttps && this.origin.startsWith('http://')) {
					this._triedHttps = true;
					const httpsOrigin = this.origin.replace(/^http:\/\//i, 'https://');
					try {
						const res2 = await this._fetch(httpsOrigin + '/ping', { method: 'GET' });
						if (res2.ok) {
							const j2 = await res2.json().catch(() => null);
							if (j2 && j2.ok) { this.origin = httpsOrigin; this.available = true; return true; }
						}
					} catch (e) { /* ignore */ }
				}
				this.available = false;
				return false;
			}
		}
		async fetchInfo() {
			try {
				const res = await this._fetch(this.origin + '/info', { method: 'GET' });
				if (!res.ok) throw new Error('HTTP ' + res.status);
				const j = await res.json().catch(() => null);
				if (j && j.ok) {
					this.base = j.base || null;
					this._running = (typeof j.running === 'boolean') ? j.running : null;
					return j;
				}
			} catch (e) { /* ignore */ }
			return null;
		}
		// helper para ler running
		isRunning() {
			return this._running === true;
		}
		async pickFolder() {
			const res = await this._fetch(this.origin + '/pick', { method: 'POST' });
			if (!res.ok) throw new Error('pick failed: ' + res.status);
			const j = await res.json().catch(() => null);
			if (j && j.ok) { this.base = j.base || null; return j; }
			throw new Error('Resposta inválida do pick');
		}
		async save(path, content) {
			// path relativo (prepareLocalSavePath garante)
			const res = await this._fetch(this.origin + '/save', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: path || 'untitled.md', content })
			});
			if (!res.ok) {
				const txt = await res.text().catch(() => null);
				throw new Error('Local server responded ' + res.status + (txt ? ': ' + txt : ''));
			}
			const j = await res.json().catch(() => null);
			if (j && j.ok) return j;
			throw new Error('Resposta inesperada do servidor local');
		}
		startPingLoop(onUpdate) {
			if (this._timer) clearInterval(this._timer);
			(async () => { await this.ping(); await this.fetchInfo(); if (typeof onUpdate === 'function') onUpdate(this); })();
			this._timer = setInterval(async () => { await this.ping(); await this.fetchInfo(); if (typeof onUpdate === 'function') onUpdate(this); }, this._pingIntervalMs);
		}
		stopPingLoop() { if (this._timer) clearInterval(this._timer); this._timer = null; }
		getLatency() { return this._lastLatency; }
	}

	// instanciar manager e função de atualização do indicador
	const Conn = new ConnectionManager('http://127.0.0.1:53423');

	function updateConnectionIndicator(){
		const el = $('connStatus');
		if(!el) return;
		const lab = el.querySelector('.label');
		if(!lab) return;

		// estado 1: servidor totalmente indisponível (ping falhou)
		if(!Conn.available){
			el.classList.remove('connected');
			el.classList.remove('connecting');
			lab.textContent = 'Desconectado';
			return;
		}

		// estado 2: ping OK, mas backend marcou running=false -> pausado
		if(!Conn.isRunning()){
			// usar classe "connecting" para aproveitar bolinha amarela
			el.classList.remove('connected');
			el.classList.add('connecting');
			lab.textContent = 'Pausado';
			return;
		}

		// estado 3: conectado e rodando
		el.classList.remove('connecting');
		el.classList.add('connected');
		const lat = Conn.getLatency();
		const baseLabel = Conn.base ? String(Conn.base).split(/[\\/]/).pop() : 'Servidor local';
		lab.textContent = baseLabel + (lat ? (' • ' + lat + 'ms') : ' • OK');
	}

	// expor ação de clique no indicador para abrir seletor (reaproveita fluxo de conexão)
	document.addEventListener('DOMContentLoaded', ()=>{
		const el = $('connStatus');
		if(el){
			el.addEventListener('click', async ()=>{
				// tentar conectar / abrir pick diretamente pelo indicador
				try{
					const up = await Conn.ping();
					if(!up){
						alert('Servidor local não respondendo. Inicie local_server.py no seu PC e tente novamente.');
						updateConnectionIndicator();
						return;
					}
					await Conn.pickFolder();
					await Conn.fetchInfo();
					updateConnectionIndicator();
				}catch(e){
					console.warn('pickFolder via indicador falhou', e);
					alert('Não foi possível abrir seletor no servidor local: ' + (e && e.message ? e.message : 'ver console'));
				}
			});
		}
	});

	// remover duplicata de updateLocalConnectButton e torná-la no-op simples
	function updateLocalConnectButton(btn){
		// mantida apenas por compatibilidade; hoje só atualiza indicador
		updateConnectionIndicator();
	}

	// NORMALIZAÇÃO do caminho que será enviado ao servidor local
	function prepareLocalSavePath(name){
		if(!name) return 'untitled.md';
		if(!Conn.base) {
			if(!/[\/\\]/.test(name) && name.indexOf('.') === -1) return name + '.md';
			return name;
		}
		const baseNorm = String(Conn.base).replace(/\\/g,'/').replace(/\/+$/,'');
		const nameNorm = String(name).replace(/\\/g,'/').replace(/\/+$/,'');
		if(nameNorm.toLowerCase().startsWith(baseNorm.toLowerCase())){
			let rel = nameNorm.slice(baseNorm.length).replace(/^\/+/, '');
			if(!rel) return 'untitled.md';
			return rel;
		}
		const baseName = baseNorm.split('/').pop();
		if(nameNorm === baseName) return 'untitled.md';
		if(!/[\/]/.test(nameNorm) && nameNorm.indexOf('.') === -1) return nameNorm + '.md';
		return name;
	}

	// nova: resolve caminho final com base no estado atual do editor
	function resolveSaveTargetName(){
		// se o arquivo atual corresponde a uma entrada conhecida, use-a (relative)
		if(currentName && allFiles.has(currentName)) return currentName;
		// se currentName parece um caminho relativo já, use prepareLocalSavePath
		if(currentName && (currentName.includes('/') || currentName.includes('\\') || currentName.includes('.'))){
			return prepareLocalSavePath(currentName);
		}
		// se temos base configurada, evitar criar "base/base": usar baseName.md como fallback
		if(Conn.base){
			const baseNorm = String(Conn.base).replace(/\\/g,'/').replace(/\/+$/,'');
			const baseName = baseNorm.split('/').pop() || 'untitled';
			// se currentName é nome da pasta, usar baseName.md
			if(currentName && (currentName === baseName || currentName === '' || currentName === baseNorm)) return baseName + '.md';
			// otherwise, append .md to simple name
			if(currentName && !currentName.includes('.') ) return currentName + '.md';
		}
		// fallback genérico
		if(currentName && currentName.indexOf('.') !== -1) return currentName;
		return (currentName && currentName.trim()) ? (currentName.trim() + '.md') : 'untitled.md';
	}

	// util
	const $ = id => document.getElementById(id);

	function norm(base, rel){
		if(!rel) return rel;
		if(/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(rel)) return rel;
		const bp = base ? base.split('/').slice(0,-1) : [];
		const parts = bp.concat(rel.split('/'));
		const out = [];
		for(const p of parts){
			if(p===''||p==='.') continue;
			if(p==='..'){ if(out.length) out.pop(); }
			else out.push(p);
		}
		return out.join('/');
	}

	function resolveMedia(src){
		if(!src) return null;
		if(/^(blob:|data:|https?:|file:)/.test(src)) return null;
		if(currentName){
			const cand = norm(currentName, src);
			if(allFiles.has(cand)) return cand;
		}
		const simple = src.replace(/^\.*\/+/, '');
		for(const k of allFiles.keys()) if(k.endsWith(src) || k.endsWith(simple)) return k;
		return null;
	}

	// Novo helper para processar mídia em qualquer container
	function processMedia(root){
		[...root.querySelectorAll('img')].forEach(async img=>{
			const src = img.getAttribute('src')||'';
			const resolved = resolveMedia(src);
			if(resolved && allFiles.has(resolved)){
				if(gitHubRepoData){
					if(gitHubToken){
						// Repositório privado: baixar blob via API autenticada
						try {
							const apiUrl = getGitHubApiContentUrl(resolved);
							const res = await ghFetch(apiUrl, { headers: { 'Accept': 'application/vnd.github.raw' } });
							if(res.ok){
								const blob = await res.blob();
								const url = URL.createObjectURL(blob);
								objectUrlMap.set(resolved, url);
								img.src = url;
							}
						} catch(e){ console.error('Erro img GH', e); }
					} else {
						img.src = getGitHubRawUrl(resolved);
					}
					if(!img.dataset.srcOriginal) img.dataset.srcOriginal = src;
					img.contentEditable = 'false';
				} else {
					const file = allFiles.get(resolved); const url = URL.createObjectURL(file);
					objectUrlMap.set(resolved, url); if(!img.dataset.srcOriginal) img.dataset.srcOriginal = src;
					img.src = url; img.contentEditable = 'false';
				}
			}
		});
		[...root.querySelectorAll('audio')].forEach(async a=>{
			const src = a.getAttribute('src')||'';

			// Se áudio estiver desativado, substituir por placeholder e não carregar blob
			if(!isAudioEnabled){
				const ph = document.createElement('div');
				ph.className = 'audio-placeholder';
				ph.textContent = '🔇 ' + (src.split('/').pop() || 'Áudio');
				ph.title = src;
				a.replaceWith(ph);
				return;
			}

			const resolved = resolveMedia(src);
			if(resolved && allFiles.has(resolved)){
				if(gitHubRepoData){
					if(gitHubToken){
						// Repositório privado: baixar blob via API autenticada
						try {
							const apiUrl = getGitHubApiContentUrl(resolved);
							const res = await ghFetch(apiUrl, { headers: { 'Accept': 'application/vnd.github.raw' } });
							if(res.ok){
								const blob = await res.blob();
								const url = URL.createObjectURL(blob);
								objectUrlMap.set(resolved, url);
								a.src = url;
							}
						} catch(e){ console.error('Erro audio GH', e); }
					} else {
						a.src = getGitHubRawUrl(resolved);
					}
					if(!a.dataset.srcOriginal) a.dataset.srcOriginal = src;
					a.contentEditable = 'false'; a.controls = true;
				} else {
					const file = allFiles.get(resolved); const url = URL.createObjectURL(file);
					objectUrlMap.set(resolved, url); if(!a.dataset.srcOriginal) a.dataset.srcOriginal = src;
					a.src = url; a.contentEditable = 'false'; a.controls = true;
				}
			}
		});
	}

	// Helper para comportamento "Source on Focus"
	function setupSourceOnFocus(wrapper){
		// Hack: Evitar que clicar em controles de mídia (audio/video) ative o modo de edição
		let ignoreFocus = false;
		wrapper.addEventListener('mousedown', function(e){
			const t = e.target;
			if(t.tagName === 'AUDIO' || t.tagName === 'VIDEO' || t.closest('audio, video')){
				ignoreFocus = true;
				setTimeout(()=> ignoreFocus = false, 200);
			}
		});

		wrapper.addEventListener('focus', function(){
			if(ignoreFocus){ ignoreFocus = false; return; }
			if(this.dataset.mode === 'source') return;
			this.dataset.mode = 'source';
			// Mostra o markdown original
			this.textContent = this.dataset.md || '';
			this.classList.add('source-mode');
		});
		wrapper.addEventListener('blur', function(){
			if(this.dataset.mode !== 'source') return; // Ignora se não estava editando
			this.dataset.mode = 'preview';
			const newSrc = this.textContent;
			this.dataset.md = newSrc;
			// Renderiza de volta para HTML
			this.innerHTML = md.render(newSrc);
			processMedia(this);
			this.classList.remove('source-mode');
			});
			
		// Novo: Interceptar Enter e Backspace
		wrapper.addEventListener('keydown', function(e){
			// Enter: Cria nova linha/bloco
			if(e.key === 'Enter'){
				e.preventDefault();
				const tag = (this.dataset.tag || '').toLowerCase();
				const isCode = tag === 'pre' || this.textContent.trim().startsWith('```');
				const isList = tag === 'ul' || tag === 'ol' || /^\s*([-*+]|\d+\.)\s/.test(this.textContent);
				const insertChars = (e.shiftKey || isCode || isList) ? '\n' : '\n\n';

				const sel = window.getSelection();
				if(sel.rangeCount){
					const range = sel.getRangeAt(0);
					const textNode = document.createTextNode(insertChars);
					range.deleteContents();
					range.insertNode(textNode);
					range.setStartAfter(textNode);
					range.setEndAfter(textNode);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			}

			// Backspace: Fundir com bloco anterior se estiver no início
			if(e.key === 'Backspace'){
				const sel = window.getSelection();
				if(!sel.rangeCount) return;
				const range = sel.getRangeAt(0);
				
				// Verificar se cursor está no início visual
				const preRange = range.cloneRange();
				preRange.selectNodeContents(this);
				preRange.setEnd(range.startContainer, range.startOffset);
				const caretAt = preRange.toString().length;

				if(caretAt === 0){
					const prev = this.previousElementSibling;
					if(prev && prev.classList.contains('block')){
						// Se o anterior for tabela, foca no final dela mas não mergeia
						if(prev.dataset.type === 'table'){
							e.preventDefault();
							focusBlockEnd(prev);
							return;
						}

						// Merge com bloco anterior (genérico)
						e.preventDefault();
						
						const currentText = this.dataset.md || this.textContent;
						const prevText = prev.dataset.md || prev.textContent;
						
						// Novo conteúdo combinado
						const newText = prevText + currentText;
						const mergePos = prevText.length;
						
						// Atualizar bloco anterior
						prev.dataset.md = newText;
						prev.textContent = newText;
						prev.classList.add('source-mode');
						prev.dataset.mode = 'source';
						
						// Remover bloco atual
						this.remove();
						
						// Atualizar editor global (reconstruir tudo pois índices mudaram)
						const allBlocks = Array.from(document.querySelectorAll('#preview .block'));
						const newEditorValue = allBlocks.map(b => getBlockMarkdown(b)).join('\n\n');
						
						saveState();
						$('editor').value = newEditorValue;
						
						// Posicionar cursor no ponto de fusão
						prev.focus();
						requestAnimationFrame(()=>{
							const r = document.createRange();
							if(prev.firstChild){
								r.setStart(prev.firstChild, mergePos);
								r.collapse(true);
								const s = window.getSelection();
								s.removeAllRanges();
								s.addRange(r);
							}
						});
					}
				}
			}
		});

		// Navegação contínua entre blocos
		wrapper.addEventListener('keydown', handleBlockNavigation);
	}

	// Helpers de navegação entre blocos (setas)
	function handleBlockNavigation(e){
		 // Removido tratamento manual de Enter para deixar o navegador/editor agir naturalmente
		if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		
		const el = e.target;
		const sel = window.getSelection();
		if(!sel.rangeCount) return;
		const range = sel.getRangeAt(0);
		const text = el.textContent;
		
		// Posição do cursor
		const preRange = range.cloneRange();
		preRange.selectNodeContents(el);
		preRange.setEnd(range.endContainer, range.endOffset);
		const caretAt = preRange.toString().length;
		
		const block = el.closest('.block');
		if(!block) return;

		if(e.key === 'ArrowUp'){
			// Se estiver na primeira linha visual (sem \n antes)
			const textBefore = text.substring(0, caretAt);
			if(!textBefore.includes('\n')){
				// Caso especial: Tabela
				if(el.tagName === 'TD'){
					const tr = el.closest('tr');
					const tbody = el.closest('tbody');
					// Se não for a primeira linha da tabela, deixa o navegador lidar
					if(tr && tbody && tbody.firstElementChild !== tr) return;
				}
				
				const prev = block.previousElementSibling;
				if(prev && prev.classList.contains('block')){
					e.preventDefault();
					focusBlockEnd(prev);
				}
			}
		} else if(e.key === 'ArrowDown'){
			// Se estiver na última linha visual (sem \n depois)
			const textAfter = text.substring(caretAt);
			if(!textAfter.includes('\n')){
				// Caso especial: Tabela
				if(el.tagName === 'TD'){
					const tr = el.closest('tr');
					const tbody = el.closest('tbody');
					// Se não for a última linha da tabela, deixa o navegador lidar
					if(tr && tbody && tbody.lastElementChild !== tr) return;
				}

				const next = block.nextElementSibling;
				if(next && next.classList.contains('block')){
					e.preventDefault();
					focusBlockStart(next);
				}
			}
		}
	}

	function focusBlockEnd(block){
		if(block.dataset.type === 'table'){
			const lastTd = block.querySelector('tbody tr:last-child td:last-child');
			if(lastTd){ lastTd.focus(); moveCaret(lastTd, false); }
		} else {
			block.focus(); moveCaret(block, false);
		}
	}

	function focusBlockStart(block){
		if(block.dataset.type === 'table'){
			const firstTd = block.querySelector('tbody tr:first-child td:first-child');
			if(firstTd){ firstTd.focus(); moveCaret(firstTd, true); }
		} else {
			block.focus(); moveCaret(block, true);
		}
	}

	function moveCaret(el, toStart){
		requestAnimationFrame(()=>{
			const r = document.createRange();
			r.selectNodeContents(el);
			r.collapse(toStart);
			const s = window.getSelection();
			s.removeAllRanges();
			s.addRange(r);
		});
	}

	// Helper para obter URL raw do GitHub se estivermos nesse modo
	function getGitHubRawUrl(path){
		if(!gitHubRepoData || !path) return null;
			// Se tiver token, não podemos usar raw.githubusercontent diretamente em tags <img> 
		// pois não conseguimos passar headers.
		// Retornamos a URL da API de conteúdo, mas isso requer tratamento especial no fetch.
		// Para simplificar compatibilidade visual sem token:
		const safePath = path.split('/').map(encodeURIComponent).join('/');
		
		// Se for privado (tem token), o ideal seria usar blob, mas para preview rápido:
		// Retorna URL raw padrão. Se for privado, vai falhar (404) em tags <img> normais.
		// A solução completa exigiria baixar o blob e criar ObjectURL para cada imagem.
		return `https://raw.githubusercontent.com/${gitHubRepoData.owner}/${gitHubRepoData.repo}/${gitHubRepoData.branch}/${safePath}`;
	}

	// Helper para obter URL da API para baixar conteúdo (suporta Token)
	function getGitHubApiContentUrl(path) {
		if(!gitHubRepoData || !path) return null;
		const safePath = path.split('/').map(encodeURIComponent).join('/');
		return `https://api.github.com/repos/${gitHubRepoData.owner}/${gitHubRepoData.repo}/contents/${safePath}?ref=${gitHubRepoData.branch}`;
	}

	function revokeObjectUrls(){
		for(const u of objectUrlMap.values()) try{ URL.revokeObjectURL(u);}catch(e){}
		objectUrlMap.clear();
	}

	// inserir texto no textarea na posição do cursor
	function insertAtCursor(textarea, text){
		if(!textarea) return;
		saveState(); // Salvar estado antes de inserir
		const start = textarea.selectionStart;
		const end = textarea.selectionEnd;
		const before = textarea.value.substring(0, start);
		const after = textarea.value.substring(end);
		textarea.value = before + text + after;
		const pos = start + text.length;
		textarea.selectionStart = textarea.selectionEnd = pos;
		textarea.focus();
	}

	// split blocks: Granular (parágrafos, headers, etc) para permitir edição WYSIWYG
	function splitBlocks(text){
		const lines = text.replace(/\r/g,'').split('\n');
		const blocks = [];
		let cur = [];
		
		const flush = () => {
			if(cur.length > 0){
				blocks.push(cur.join('\n'));
				cur = [];
			}
		};

		// Detecta início de tabela
		const isTableStart = (i) => {
			if(i + 1 >= lines.length) return false;
			const l1 = lines[i].trim();
			const l2 = lines[i+1].trim();
			if(!l1.includes('|')) return false;
			return /^\|?[\s\-:|]+\|?$/.test(l2) && l2.includes('---');
		};

		let i = 0;
		while(i < lines.length){
			const line = lines[i];
			const trim = line.trim();

			// Code Fences
			if(trim.startsWith('```')){
				flush();
				cur.push(line);
				i++;
				while(i < lines.length){
					cur.push(lines[i]);
					if(lines[i].trim().startsWith('```')){
						i++;
						break;
					}
					i++;
				}
				flush();
				continue;
			}

			// Tabela
			if(isTableStart(i)){
				flush();
				while(i < lines.length){
					const tLine = lines[i];
					if(tLine.trim() === '') break;
					cur.push(tLine);
					i++;
				}
				flush();
				continue;
			}

			// Linha vazia -> separador de bloco
			if(trim === ''){
				flush();
				i++;
				continue;
			}

			// Header (ATX) - Novo: Headers quebram o bloco imediatamente
			if(/^#{1,6}(\s|$)/.test(trim)){
				flush();
				blocks.push(line);
				i++;
				continue;
			}

			cur.push(line);
			i++;
		}
		flush();
		return blocks;
	}

	// parse table markdown (simple)
	function parseTable(block){
		const lines = block.replace(/\r/g,'').split('\n');
		const header = lines[0]||'';
		const sep = lines[1]||'';
		const body = lines.slice(2);
		const leading = /^\s*\|/.test(header);
		const trailing = /\|\s*$/.test(header);
		function splitCells(line){
			let s = line;
			if(leading) s = s.replace(/^\s*\|/,'');
			if(trailing) s = s.replace(/\|\s*$/,'');
			return s.split('|').map(c=>c.trim());
		}
		const headers = splitCells(header);
		const sepCells = splitCells(sep);
		const aligns = sepCells.map(s=>{
			if(/^:?-+:?$/.test(s)){
				const l = s.startsWith(':'); const r = s.endsWith(':');
				if(l&&r) return 'center';
				if(l) return 'left';
				if(r) return 'right';
			}
			return 'default';
		});
		const rows = body.map(l=>splitCells(l));
		return {leading,trailing,headers,aligns,rows};
	}

	// serialize inner HTML media back to original path when saving table cells with HTML
	function serializeHtml(html){
		const tmp = document.createElement('div'); tmp.innerHTML = html||'';
		tmp.querySelectorAll('img,audio,video,source').forEach(el=>{
			if(el.dataset && el.dataset.srcOriginal) el.setAttribute('src', el.dataset.srcOriginal);
			else {
				for(const [p,u] of objectUrlMap.entries()) try{ if(el.src===u){ el.setAttribute('src', p); break; } }catch(e){}
			}
			el.removeAttribute('contenteditable');
		});
		return tmp.innerHTML.trim();
	}

	// Helper para extrair markdown de um bloco (usado em applyBlockEdit e merge)
	function getBlockMarkdown(wrapper){
		const type = wrapper.dataset.type;
		if(type === 'table'){
			const table = wrapper.querySelector('table');
			if(!table) return wrapper.dataset.orig || '';
			
			const esc = t => (t||'').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
			const getCellContent = (cellEl) => {
				if(cellEl === document.activeElement) return esc(cellEl.textContent).trim();
				if(cellEl.dataset.md !== undefined) return esc(cellEl.dataset.md).trim();
				if(cellEl.dataset.hasHtml){
					const html = serializeHtml(cellEl.innerHTML);
					return esc(td.turndown(html)).trim();
				}
				return esc(cellEl.textContent).trim();
			};

			const ths = [...table.querySelectorAll('thead th')].map(t=> t.dataset.hasHtml ? serializeHtml(t.innerHTML) : esc(t.textContent).trim());
			const trs = [...table.querySelectorAll('tbody tr')].map(tr=> 
				[...tr.querySelectorAll('td')].map(cellEl => getCellContent(cellEl))
			);

			const leading = '|', trailing = '|';
			const headerLine = leading + ths.map(c=>' '+c+' ').join('|') + trailing;
			const sepLine = leading + ths.map(()=> ' --- ').join('|') + trailing;
			const body = trs.map(r=> leading + r.map(c=>' '+c+' ').join('|') + trailing).join('\n');
			return [headerLine, sepLine, body].join('\n');
		} else {
			// Genérico
			// Correção: Se estiver em modo source, o textContent é o valor mais atual (ainda não salvo no dataset.md)
			if(wrapper.classList.contains('source-mode') || wrapper.dataset.mode === 'source'){
				return wrapper.textContent;
			}
			if(wrapper.dataset.md !== undefined) return wrapper.dataset.md;
			// Fallback
			if(wrapper.querySelector && wrapper.querySelector('audio')) return wrapper.innerHTML.trim();
			const clone = wrapper.cloneNode(true);
			clone.querySelectorAll('.editHint').forEach(e=>e.remove());
			return td.turndown(clone.innerHTML).trim();
		}
	}

	// context menu
	let __contextMenuEl = null;
	let __contextDocClickHandler = null; // handler para fechar o menu ao clicar com botão esquerdo

	function createContextMenu(){
		if(__contextMenuEl) return;
		__contextMenuEl = document.createElement('div');
		__contextMenuEl.className = 'context-menu hidden';
		// adicionada opção add-audio
		__contextMenuEl.innerHTML = '<div class="cm-item" data-action="insert-row">Inserir linha</div><div class="cm-item" data-action="delete-row">Excluir linha</div><div class="cm-item" data-action="add-audio">Adicionar áudio</div>';
		document.body.appendChild(__contextMenuEl);

		__contextMenuEl.addEventListener('click', (e)=>{
			const it = e.target && e.target.closest && e.target.closest('.cm-item');
			if(!it) return;
			const action = it.dataset.action;
			const bIdx = Number(__contextMenuEl.dataset.blockIdx);
			const rIdx = Number(__contextMenuEl.dataset.rowIdx);
			const cIdx = Number(__contextMenuEl.dataset.colIdx);
			hideContextMenu();
			if(action === 'delete-row'){
				deleteRowAt(bIdx, rIdx);
			} else if(action === 'insert-row'){
				addRowAfter(bIdx, rIdx);
			} else if(action === 'add-audio'){
				// abrir picker de áudio (passa colIdx também)
				showAudioPicker(bIdx, isNaN(rIdx) ? null : rIdx, isNaN(cIdx) ? null : cIdx);
			}
		});
		 
		// fecha ao pressionar Escape
		document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') hideContextMenu(); });
		
		// fecha ao clicar/pressionar pointer (mouse/touch) em qualquer lugar OUTSIDE do menu
		// usamos pointerdown em modo de captura para garantir que o handler execute antes de qualquer stopPropagation em handlers de bubble
		__contextDocClickHandler = function(e){
			// se for mouse, ignorar botões que não sejam o esquerdo
			if(e.pointerType === 'mouse' && typeof e.button !== 'undefined' && e.button !== 0) return;
			if(!__contextMenuEl || __contextMenuEl.classList.contains('hidden')) return;
			// se o clique aconteceu dentro do menu, não fechar aqui (itens tratam o fechamento)
			if(__contextMenuEl.contains(e.target)) return;
			hideContextMenu();
		};
		document.addEventListener('pointerdown', __contextDocClickHandler, true); // captura
	}

	function showContextMenu(x,y,data){
		createContextMenu();
		__contextMenuEl.dataset.blockIdx = data.blockIdx;
		__contextMenuEl.dataset.rowIdx = data.rowIdx;
		__contextMenuEl.dataset.colIdx = (typeof data.colIdx === 'undefined') ? '' : data.colIdx;
		__contextMenuEl.classList.remove('hidden');
		__contextMenuEl.style.left = '0px'; __contextMenuEl.style.top = '0px';
		const pad = 8;
		const rect = __contextMenuEl.getBoundingClientRect();
		let left = x, top = y;
		const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
		const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
		if(left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
		if(top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
		__contextMenuEl.style.left = left + 'px';
		__contextMenuEl.style.top = top + 'px';
	}
	function hideContextMenu(){
		if(!__contextMenuEl) return;
		__contextMenuEl.classList.add('hidden');
		__contextMenuEl.style.left = ''; __contextMenuEl.style.top = '';
	}

	// --- Audio picker (mini pop-up) ---
	let __audioPickerEl = null;
	let __audioPickerDocHandler = null;
	let __audioPickerRO = null; // ResizeObserver para ajustar layout ao redimensionar

	function createAudioPicker(){
		if(__audioPickerEl) return;
		__audioPickerEl = document.createElement('div');
		__audioPickerEl.className = 'audio-picker hidden';
		__audioPickerEl.innerHTML = `
			<div class="ap-header"><input type="search" placeholder="Pesquisar áudio..." aria-label="Pesquisar áudio" /></div>
			<ul class="ap-list"></ul>
		`;
		document.body.appendChild(__audioPickerEl);

		 // atualiza alturas / posição interna para "preencher" corretamente
		function updateAudioPickerLayout(){
			if(!__audioPickerEl) return;
			const ap = __audioPickerEl;
			const header = ap.querySelector('.ap-header');
			const list = ap.querySelector('.ap-list');
			// calcular paddings do container
			const cs = getComputedStyle(ap);
			const padTop = parseFloat(cs.paddingTop) || 0;
			const padBottom = parseFloat(cs.paddingBottom) || 0;
			const headerH = header ? header.getBoundingClientRect().height : 0;
			const available = Math.max(60, ap.clientHeight - headerH - padTop - padBottom - 8);
			if(list) list.style.maxHeight = available + 'px';
			// garantir que o popup continue visível na viewport
			const rect = ap.getBoundingClientRect();
			let left = rect.left, top = rect.top;
			const pad = 8;
			if(rect.right > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
			if(rect.bottom > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
			ap.style.left = left + 'px';
			ap.style.top = top + 'px';
		}

		 // expor a função para uso externo (showAudioPicker)
		__audioPickerEl._updateLayout = updateAudioPickerLayout;

		// criar ResizeObserver (dispara quando o usuário redimensiona o elemento) ou fallback
		if(window.ResizeObserver){
			__audioPickerRO = new ResizeObserver(()=> requestAnimationFrame(updateAudioPickerLayout));
			try{ __audioPickerRO.observe(__audioPickerEl); }catch(e){ /* ignore */ }
		} else {
			// fallback: ajustar ao redimensionar janela
			window.addEventListener('resize', updateAudioPickerLayout);
		}

		// clicar num item -> inserir áudio
		__audioPickerEl.addEventListener('click', (e)=>{
			const li = e.target && e.target.closest && e.target.closest('li[data-path]');
			if(!li) return;
			const path = li.dataset.path;
			// obter índices do dataset (podem vir vazios)
			const bIdxRaw = __audioPickerEl.dataset.blockIdx;
			const rIdxRaw = __audioPickerEl.dataset.rowIdx;
			const cIdxRaw = __audioPickerEl.dataset.colIdx;
			const bIdx = (typeof bIdxRaw === 'undefined' || bIdxRaw === '') ? null : Number(bIdxRaw);
			const rIdx = (typeof rIdxRaw === 'undefined' || rIdxRaw === '') ? null : Number(rIdxRaw);
			const cIdx = (typeof cIdxRaw === 'undefined' || cIdxRaw === '') ? null : Number(cIdxRaw);
			hideAudioPicker();
			if(path && bIdx!==null && typeof bIdx !== 'undefined') insertAudioIntoTable(bIdx, rIdx, cIdx, path);
		});

		// search input
		const inp = __audioPickerEl.querySelector('input');
		let tmo = null;
		inp.addEventListener('input', ()=>{
			if(tmo) clearTimeout(tmo);
			tmo = setTimeout(()=> { buildAudioList(inp.value.trim().toLowerCase()); }, 120);
		});

		// fechar ao Esc
		document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') hideAudioPicker(); });

		// fechar ao clicar fora (captura)
		__audioPickerDocHandler = function(e){
			if(!__audioPickerEl || __audioPickerEl.classList.contains('hidden')) return;
			if(__audioPickerEl.contains(e.target)) return;
			hideAudioPicker();
		};
		document.addEventListener('pointerdown', __audioPickerDocHandler, true);
	}

	// showAudioPicker now accepts colIdx
	function showAudioPicker(blockIdx, rowIdx, colIdx){
		createAudioPicker();
		__audioPickerEl.dataset.blockIdx = (blockIdx===null||typeof blockIdx==='undefined') ? '' : String(blockIdx);
		__audioPickerEl.dataset.rowIdx = (rowIdx===null||typeof rowIdx==='undefined') ? '' : String(rowIdx);
		__audioPickerEl.dataset.colIdx = (colIdx===null||typeof colIdx==='undefined') ? '' : String(colIdx);
		__audioPickerEl.classList.remove('hidden');
		// posicionar próximo ao context menu se existir
		if(__contextMenuEl && !__contextMenuEl.classList.contains('hidden')){
			const crect = __contextMenuEl.getBoundingClientRect();
			const pad = 6;
			__audioPickerEl.style.left = Math.min(window.innerWidth - 320 - pad, crect.right + pad) + 'px';
			__audioPickerEl.style.top = crect.top + 'px';
		} else {
			// center fallback
			__audioPickerEl.style.left = Math.max(8, (window.innerWidth/2 - 160)) + 'px';
			__audioPickerEl.style.top = Math.max(8, (window.innerHeight/2 - 120)) + 'px';
		}
		const inp = __audioPickerEl.querySelector('input');
		if(inp){ inp.value = ''; inp.focus(); }
		buildAudioList('');
		// ajustar layout imediatamente usando a função exposta
		requestAnimationFrame(()=> {
			if(__audioPickerEl && typeof __audioPickerEl._updateLayout === 'function') __audioPickerEl._updateLayout();
		});
	}

	function hideAudioPicker(){
		if(!__audioPickerEl) return;
		__audioPickerEl.classList.add('hidden');
		__audioPickerEl.style.left = ''; __audioPickerEl.style.top = '';
		__audioPickerEl.dataset.blockIdx = ''; __audioPickerEl.dataset.rowIdx = '';
		// manter observer ativo para reuso; não desconectamos aqui para permitir reuso rápido
	}

	function buildAudioList(filter){
		if(!__audioPickerEl) return;
		const ul = __audioPickerEl.querySelector('.ap-list');
		ul.innerHTML = '';
		const audExt = ['mp3','wav','ogg','m4a','flac','aac'];
		const entries = [];
		for(const k of allFiles.keys()){
			const n = k.split('/').pop().toLowerCase();
			const ext = n.split('.').pop() || '';
			if(audExt.includes(ext)) entries.push(k);
		}
		entries.sort((a,b)=> a.localeCompare(b,'pt',{numeric:true}));
		const filtered = filter ? entries.filter(p => p.toLowerCase().includes(filter)) : entries;
		if(filtered.length === 0){
			const li = document.createElement('li'); li.className='empty'; li.textContent = 'Nenhum áudio encontrado';
			ul.appendChild(li); return;
		}
		filtered.forEach(p=>{
			const name = p.split('/').pop();
			const li = document.createElement('li');
			li.dataset.path = p;
			li.innerHTML = `<span class="file-icon">🎵</span><span class="ap-name">${name}</span><span class="ap-path">${p}</span>`;
			ul.appendChild(li);
		});
	}

	// insere tag <audio> dentro de uma célula (ou cria linha) atualizando o markdown do editor
	// agora aceita colIdx (terceiro parâmetro antes do path)
	function insertAudioIntoTable(blockIdx, rowIdx, colIdx, path){
		try{
			const text = $('editor').value;
			const blocks = splitBlocks(text);
			const blk = blocks[blockIdx] || '';
			const parsed = parseTable(blk);
			// garantir existência de headers
			if(!parsed.headers || parsed.headers.length === 0){
				// nada a fazer
				return;
			}
			// se não há linhas, cria uma
			if(!parsed.rows || parsed.rows.length === 0) parsed.rows = [ parsed.headers.map(()=> '') ];
			let targetRow = (typeof rowIdx === 'number' && rowIdx>=0 && rowIdx < parsed.rows.length) ? rowIdx : (parsed.rows.length - 1);
			// determinar coluna alvo: prioridade colIdx param > currentTableColIdx > 0
			let targetCol = (typeof colIdx === 'number' && colIdx >= 0) ? colIdx : (typeof currentTableColIdx === 'number' ? currentTableColIdx : 0);
			// garantir que a row tenha células suficientes
			const headerCount = parsed.headers.length || 1;
			if(parsed.rows[targetRow].length < headerCount){
				while(parsed.rows[targetRow].length < headerCount) parsed.rows[targetRow].push('');
			}
			// garantir que targetCol exista
			if(targetCol >= parsed.rows[targetRow].length) targetCol = parsed.rows[targetRow].length - 1;

			// insere o audio no cell indicado (concatena)
			const filename = path.split('/').pop();
			const tag = `<audio controls src="${path}" title="${filename}"></audio>`;
			parsed.rows[targetRow][targetCol] = (parsed.rows[targetRow][targetCol] || '') + tag;

			// reserializar tabela (reutiliza lógica já presente)
			const leading = parsed.leading ? '|' : '';
			const trailing = parsed.trailing ? '|' : '';
			const headerLine = leading + parsed.headers.map(c=>' '+c+' ').join('|') + (trailing? '|':'');
			const sepLine = leading + (parsed.aligns || parsed.headers.map(()=> 'default')).map(a=>{
				if(a==='left') return ':---';
				if(a==='right') return '---:';
				if(a==='center') return ':---:';
				return '---';
			}).map(s=>' '+s+' ').join('|') + (trailing? '|':'');
			const body = parsed.rows.map(r=> leading + r.map(c=>' '+c+' ').join('|') + (trailing? '|':'')).join('\n');
			blocks[blockIdx] = [headerLine, sepLine, body].join('\n');
			saveState(); // Salvar antes de aplicar
			$('editor').value = blocks.join('\n\n');
			renderPreviewFrom($('editor').value);
		}catch(e){ console.error('insertAudioIntoTable erro', e); }
	}

	// context menu for explorer (right-click on files)
	let __explorerContextMenuEl = null;
	let __explorerContextDocHandler = null;

	function createExplorerContextMenu(){
		if(__explorerContextMenuEl) return;
		__explorerContextMenuEl = document.createElement('div');
		__explorerContextMenuEl.className = 'explorer-context-menu hidden';
		// Alterado: Removido "Abrir em nova aba"
		__explorerContextMenuEl.innerHTML = '<div class="ecm-item" data-action="rename">Renomear...</div><div class="ecm-item" data-action="copy">Copiar nome</div>';
		document.body.appendChild(__explorerContextMenuEl);

		__explorerContextMenuEl.addEventListener('click', (e)=>{
			const it = e.target && e.target.closest && e.target.closest('.ecm-item');
			if(!it) return;
			const action = it.dataset.action;
			const path = __explorerContextMenuEl.dataset.path;
			hideExplorerContextMenu();
			// Alterado: Removido handler de open-new-tab
			if(action === 'rename') renameFile(path);
			if(action === 'copy') copyFileName(path);
		});

		__explorerContextDocHandler = function(e){
			if(!__explorerContextMenuEl || __explorerContextMenuEl.classList.contains('hidden')) return;
			if(__explorerContextMenuEl.contains(e.target)) return;
			hideExplorerContextMenu();
		};
		document.addEventListener('pointerdown', __explorerContextDocHandler, true);
	}
	function showExplorerContextMenu(x,y,path){
		createExplorerContextMenu();
		__explorerContextMenuEl.dataset.path = path;
		__explorerContextMenuEl.classList.remove('hidden');
		const pad = 8;
		const rect = __explorerContextMenuEl.getBoundingClientRect();
		let left = x, top = y;
		const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
		const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
		if(left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
		if(top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
		__explorerContextMenuEl.style.left = left + 'px';
		__explorerContextMenuEl.style.top = top + 'px';
	}
	function hideExplorerContextMenu(){
		if(!__explorerContextMenuEl) return;
		__explorerContextMenuEl.classList.add('hidden');
		__explorerContextMenuEl.style.left = ''; __explorerContextMenuEl.style.top = '';
	}

	// --- Explorer Hover Preview ---
	let __previewTimer = null;
	let __previewEl = null;
	let __previewUrl = null;
	let __currentPreviewPath = null;

	function createPreviewPopup() {
		if (__previewEl) return;
		__previewEl = document.createElement('div');
		__previewEl.className = 'explorer-preview-popup hidden';
		document.body.appendChild(__previewEl);
	}

	function hidePreviewPopup() {
		if (__previewTimer) clearTimeout(__previewTimer);
		__previewTimer = null;
		if (__previewEl) {
			__previewEl.classList.add('hidden');
			// Parar áudio se estiver tocando
			const audio = __previewEl.querySelector('audio');
			if(audio) { audio.pause(); audio.src = ''; }
			__previewEl.innerHTML = '';
		}
		if (__previewUrl) {
			URL.revokeObjectURL(__previewUrl);
			__previewUrl = null;
		}
		__currentPreviewPath = null;
	}

	async function showPreviewPopup(targetEl, path) {
		createPreviewPopup();
		__currentPreviewPath = path;
		
		const file = allFiles.get(path);
		if (!file) return;

		const ext = (path.split('.').pop()||'').toLowerCase();
		let content = '';
		
		// Limpar URL anterior
		if (__previewUrl) { URL.revokeObjectURL(__previewUrl); __previewUrl = null; }

		// Se for GitHub e tiver token, precisamos baixar o blob para preview de imagem/audio funcionar
		if (gitHubRepoData && gitHubToken && ['png','jpg','jpeg','gif','webp','svg','mp3','wav','ogg','m4a'].includes(ext)) {
			try {
				const apiUrl = getGitHubApiContentUrl(path);
				const res = await ghFetch(apiUrl, { headers: { 'Accept': 'application/vnd.github.raw' } });
				if(res.ok) {
					const blob = await res.blob();
					__previewUrl = URL.createObjectURL(blob);
				}
			} catch(e) { console.error('Erro preview GH', e); }
		}

		if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
			if(gitHubRepoData) {
				// Se conseguimos baixar o blob acima, usa ele. Se não, tenta raw url (funciona se publico)
				const url = __previewUrl || getGitHubRawUrl(path);
				content = `<img src="${url}" style="max-width:100%; max-height:180px; display:block; border-radius:4px;">`;
			} else {
				__previewUrl = URL.createObjectURL(file);
				content = `<img src="${__previewUrl}" style="max-width:100%; max-height:180px; display:block; border-radius:4px;">`;
			}
		} else if (['mp3','wav','ogg','m4a'].includes(ext)) {
			if(gitHubRepoData) {
				const url = __previewUrl || getGitHubRawUrl(path);
				content = `<audio controls autoplay src="${url}" style="width:100%; height:32px;"></audio>`;
			} else {
				__previewUrl = URL.createObjectURL(file);
				content = `<audio controls autoplay src="${__previewUrl}" style="width:100%; height:32px;"></audio>`;
			}
		} else if (['md','txt','js','json','css','html','py'].includes(ext)) {
			// Preview de texto (limitado)
			try {
				let text = '';
				if(gitHubRepoData && file.size === 0) text = "(Carregando do GitHub...)";
				else text = await file.slice(0, 1000).text();
				
				content = `<pre style="margin:0; font-size:10px; white-space:pre-wrap; max-height:180px; overflow:hidden; color:#aaa;">${text.slice(0,500).replace(/</g,'&lt;') + (text.length>500?'...':'')}</pre>`;
			} catch(e) { return; }
		} else {
			return; // Tipo sem preview
		}

		if (__currentPreviewPath !== path) return; // Mudou enquanto carregava

		__previewEl.innerHTML = content;
		__previewEl.classList.remove('hidden');

		// Posicionamento
		const rect = targetEl.getBoundingClientRect();
		const pRect = __previewEl.getBoundingClientRect();
		
		// Tenta posicionar à direita, se não der, em cima ou embaixo
		let top = rect.top;
		let left = rect.right + 12;
		
		if (left + pRect.width > window.innerWidth) {
			left = rect.left + 20;
			top = rect.bottom + 8;
		}
		
		// Ajuste vertical se sair da tela
		if (top + pRect.height > window.innerHeight) {
			top = window.innerHeight - pRect.height - 10;
		}

		__previewEl.style.top = top + 'px';
		__previewEl.style.left = left + 'px';
	}

	// copiar nome do arquivo (apenas o basename)
	async function copyFileName(path){
		const name = (path || '').split('/').pop() || '';
		try{
			await navigator.clipboard.writeText(name);
		}catch(e){
			// fallback
			const ta = document.createElement('textarea'); ta.value = name; document.body.appendChild(ta);
			ta.select(); document.execCommand('copy'); ta.remove();
		}
	}

	// renomear arquivo (prompt) — atualiza allFiles / mdFiles / objectUrlMap keys
	function renameFile(oldPath){
		if(!allFiles.has(oldPath)) return alert('Arquivo não encontrado: ' + oldPath);
		const oldName = oldPath.split('/').pop();
		const dir = oldPath.split('/').slice(0,-1).join('/');
		const inp = prompt('Novo nome do arquivo:', oldName);
		if(!inp) return;
		const newName = inp.trim();
		if(!newName) return;
		const newPath = dir ? dir + '/' + newName : newName;
		if(newPath === oldPath) return;
		if(allFiles.has(newPath)) return alert('Já existe um arquivo com esse nome neste local.');
		const file = allFiles.get(oldPath);
		allFiles.delete(oldPath);
		allFiles.set(newPath, file);
		// mdFiles
		if(/\.md$/i.test(oldPath) || /\.md$/i.test(newPath)){
			if(mdFiles.has(oldPath)) mdFiles.delete(oldPath);
			if(/\.md$/i.test(newPath)) mdFiles.set(newPath, file);
		}
		// objectUrlMap
		if(objectUrlMap.has(oldPath)){
			const url = objectUrlMap.get(oldPath);
			objectUrlMap.delete(oldPath);
			objectUrlMap.set(newPath, url);
		}
		// atualizar currentName se necessário
		if(currentName === oldPath) currentName = newPath;
		// re-render explorer + preview if needed
		renderExplorerUI();
		// atualizar editor se o arquivo em edição era esse
		if(currentName === newPath && $('editor')) renderPreviewFrom($('editor').value);
	}

	// render preview
	function renderPreviewFrom(text){
		revokeObjectUrls();
		const preview = $('preview');
		preview.innerHTML = '';
		const blocks = splitBlocks(text);
		blocks.forEach((blk, idx)=>{
			const wrapper = document.createElement('div');
			wrapper.className = 'block';
			wrapper.dataset.idx = idx;
			wrapper.dataset.orig = blk;

			// Detectar tabela (lógica existente)
			const secondLine = (blk.split('\n')[1]||'').trim();
			const isTable = /\|/.test(blk) && /^\s*[:\-\s|]+\s*$/.test(secondLine);

			if(isTable){
				// Lógica de tabela (mantida)
				const parsed = parseTable(blk);
				// criar wrapper que contém a coluna de handles (fora da tabela) + tabela
				const wrapperTable = document.createElement('div');
				wrapperTable.className = 'table-with-handles';
				const handlesCol = document.createElement('div');
				handlesCol.className = 'handles-col';
				const table = document.createElement('table'); table.className = 'md-table';
				// cabeçalho (sem col extra)
				const thead = document.createElement('thead'); const trh = document.createElement('tr');
				parsed.headers.forEach(h=>{
					const th = document.createElement('th');
					if(/<\s*(audio|img|video)/i.test(h)){ th.innerHTML = h; th.dataset.hasHtml = '1'; }
					else th.textContent = h;
					trh.appendChild(th);
				});
				thead.appendChild(trh); table.appendChild(thead);
				const tbody = document.createElement('tbody');
				(parsed.rows.length? parsed.rows : [[]]).forEach((row, rIdx)=>{
					// criar linha da tabela normalmente (apenas células de dados)
					const tr = document.createElement('tr');
					row.forEach((cell, cIdx)=>{ // <-- agora temos cIdx
						const tdEl = document.createElement('td');
						 // Armazenar o Markdown original como fonte da verdade
						tdEl.dataset.md = cell;

						// Detectar mídia (não editável diretamente via texto)
						const isMedia = /!\[.*?\]\(.*?\)|<\s*(audio|img|video)/i.test(cell);

						if(isMedia){
							tdEl.innerHTML = md.renderInline(cell);
							tdEl.dataset.hasHtml = '1';
							tdEl.contentEditable = 'false';
							tdEl.addEventListener('dblclick', ()=> openCellModal(tdEl, idx));
							processMedia(tdEl); // <--- Adicionado: Resolver URLs de mídia (blob) na tabela
						} else {
							// Texto: Renderiza HTML visualmente, mas edita o fonte (Markdown)
							tdEl.innerHTML = md.renderInline(cell);
							tdEl.contentEditable = 'true';

							// Ao focar (clicar): mostra o código fonte (ex: <br>, `code`)
							tdEl.addEventListener('focus', function(){
								// Usa o dataset.md para garantir que pegamos o original
								this.textContent = this.dataset.md || '';
							});

							// Ao sair (blur): salva o novo fonte e renderiza novamente
							tdEl.addEventListener('blur', function(){
								const newRaw = this.textContent;
								this.dataset.md = newRaw;
								this.innerHTML = md.renderInline(newRaw);
								// Nota: applyBlockEdit será chamado em seguida pelo blur do wrapper
								});
								
								// Navegação
								tdEl.addEventListener('keydown', handleBlockNavigation);
							}
							// clique simples: registra célula atual
						tdEl.addEventListener('click', (ev)=>{
							ev.stopPropagation();
							currentTableIdx = idx;
							currentTableRowIdx = rIdx;
							currentTableColIdx = cIdx;
							preview.querySelectorAll('tr.selected-row').forEach(el=>el.classList.remove('selected-row'));
							tr.classList.add('selected-row');
						});
						tr.appendChild(tdEl);
					});
					tr.dataset.rowIdx = rIdx;
					 
					// (nenhum listener per-tr aqui; o tbody vai gerir dragover/drop centralmente)
					tbody.appendChild(tr);

					// criar handle fora da tabela e associar eventos de drag
					const h = document.createElement('div');
					h.className = 'row-handle';
					h.innerHTML = '<span class="row-handle-ico">::</span>';
					h.dataset.rowIdx = rIdx;
					h.draggable = true;
					h.addEventListener('dragstart', (e)=>{
						__dragInfo = { blockIdx: idx, rowIdx: Number(h.dataset.rowIdx) };
						try{
							// comunicar bloco/linha arrastada (compatível com outros handlers)
							const payload = JSON.stringify({ blockIdx: idx, rowIdx: Number(h.dataset.rowIdx) });
							e.dataTransfer.setData('application/json', payload);
							e.dataTransfer.setData('text/plain', payload);
							e.dataTransfer.effectAllowed = 'move';
							// usar o próprio elemento como drag image (reduz problemas visuais)
							if(e.dataTransfer.setDragImage) try{ e.dataTransfer.setDragImage(h, 10, 10); }catch(_){}
						}catch(err){}
						// marcar linha correspondente para feedback
						const trows = tbody.querySelectorAll('tr');
						const targetTr = trows[Number(h.dataset.rowIdx)];
						if(targetTr) targetTr.classList.add('dragging');
						});
					h.addEventListener('dragend', ()=>{
						__dragInfo = null;
						tbody.querySelectorAll('tr.dragging').forEach(t=>t.classList.remove('dragging'));
						tbody.querySelectorAll('tr.drop-target').forEach(t=>t.classList.remove('drop-target'));
					});
					handlesCol.appendChild(h);
				});

				table.appendChild(tbody);

				// REMOVIDO: Listeners de dragover/drop do tbody foram movidos para enablePreviewDrop
				// para evitar conflitos e centralizar a lógica.

				// colocar handles e table no wrapper
				wrapperTable.appendChild(handlesCol);
				wrapperTable.appendChild(table);
				wrapper.appendChild(wrapperTable);
				wrapper.dataset.type = 'table';
				wrapper.dataset.meta = JSON.stringify(parsed);

				// add listeners to rows
				[...wrapper.querySelectorAll('tbody tr')].forEach((tr, rIdx)=>{
					tr.addEventListener('click', ev=>{
						ev.stopPropagation();
						currentTableIdx = idx;
						currentTableRowIdx = rIdx;
						// detectar célula clicada (se o click veio de um td)
						const td = ev.target && ev.target.closest ? ev.target.closest('td') : null;
						currentTableColIdx = td ? Array.from(tr.children).indexOf(td) : null;
						preview.querySelectorAll('tr.selected-row').forEach(el=>el.classList.remove('selected-row'));
						tr.classList.add('selected-row');
					});
					tr.addEventListener('contextmenu', ev=>{
						ev.preventDefault(); ev.stopPropagation();
						currentTableIdx = idx; currentTableRowIdx = rIdx;
						preview.querySelectorAll('tr.selected-row').forEach(el=>el.classList.remove('selected-row'));
						// descobrir coluna clicada (se houver)
						const td = ev.target && ev.target.closest ? ev.target.closest('td') : null;
						const colIdx = td ? Array.from(tr.children).indexOf(td) : null;
						showContextMenu(ev.clientX, ev.clientY, {blockIdx: idx, rowIdx: rIdx, colIdx});
					});
					// contextmenu também no espaço da tabela (quando não clicar numa linha)
					table.addEventListener('contextmenu', ev => {
						ev.preventDefault(); ev.stopPropagation();
						// se clicou dentro de uma <tr>, deixa o handler da linha cuidar
						const trEl = ev.target && ev.target.closest ? ev.target.closest('tr') : null;
						if(trEl) return;
						// marca apenas a tabela (sem linha selecionada) e abre o menu
						currentTableIdx = idx;
						currentTableRowIdx = null;
						currentTableColIdx = null;
						preview.querySelectorAll('tr.selected-row').forEach(el=>el.classList.remove('selected-row'));
						showContextMenu(ev.clientX, ev.clientY, {blockIdx: idx, rowIdx: null, colIdx: null});
					});
				});
			} else {
				// Todos os outros blocos (Texto, Lista, Código, HTML)
				// Usam o padrão "Source on Focus"
				wrapper.dataset.md = blk;
				wrapper.innerHTML = md.render(blk);
				
				// Detectar tag principal para styling no modo source (ex: manter H1 grande)
				const firstChild = wrapper.firstElementChild;
				if(firstChild) wrapper.dataset.tag = firstChild.tagName.toLowerCase();

				processMedia(wrapper);
				wrapper.contentEditable = 'true';
				wrapper.dataset.type = 'generic'; // Tipo genérico
				wrapper.classList.add('text-block'); // <--- Novo: Classe para remover estilo de "bloco" no CSS
				setupSourceOnFocus(wrapper);
			}

			preview.appendChild(wrapper);

			wrapper.addEventListener('click', (e)=>{
				if(wrapper.dataset.type === 'table') currentTableIdx = idx;
				else currentTableIdx = null;
				currentTableRowIdx = null;
				preview.querySelectorAll('tr.selected-row').forEach(el=>el.classList.remove('selected-row'));
			});
			wrapper.addEventListener('blur', ()=> applyBlockEdit(idx, wrapper), true);

			// sincroniza alturas dos handles com as linhas visíveis (chave: chamar depois de append)
			if(isTable) (function syncHandlesOnce(w){
				const wrapperTable = w.querySelector('.table-with-handles');
				if(!wrapperTable) return;
				const handlesCol = wrapperTable.querySelector('.handles-col');
				const tableEl = wrapperTable.querySelector('table.md-table');
				if(!handlesCol || !tableEl) return;

				const update = ()=>{
					const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
					const handles = Array.from(handlesCol.querySelectorAll('.row-handle'));
					const thead = tableEl.querySelector('thead');
					const headerH = thead ? thead.getBoundingClientRect().height : 0;
					// ajustar altura da coluna (cobre tbody) e padding-top para alinhar ao header
					const tbody = tableEl.querySelector('tbody');
					const tbodyRect = tbody ? tbody.getBoundingClientRect() : tableEl.getBoundingClientRect();
					handlesCol.style.paddingTop = String(Math.max(0, headerH)) + 'px';
					handlesCol.style.height = String(Math.max(0, tbodyRect.height)) + 'px';
					const handlesColRect = handlesCol.getBoundingClientRect();
					// posicionar cada handle exatamente sobre a linha correspondente
					rows.forEach((r,i)=>{
						const h = handles[i];
						if(h){
							const rRect = r.getBoundingClientRect();
							const top = Math.round(rRect.top - handlesColRect.top);
							const height = Math.max(Math.round(rRect.height), 28);
							h.style.top = top + 'px';
							h.style.height = height + 'px';
						}
					});
				};

				// atualização inicial (duas frames para layout estável)
				requestAnimationFrame(()=> requestAnimationFrame(update));

				// ResizeObserver para atualizar automaticamente quando linha muda de altura
				const ro = new ResizeObserver(()=> requestAnimationFrame(update));
				// observar thead e todas as tr atuais
				const thead = tableEl.querySelector('thead');
				if(thead) ro.observe(thead);
				tableEl.querySelectorAll('tbody tr').forEach(r=> ro.observe(r));

				// MutationObserver para re-observar quando linhas são adicionadas/removidas
				const tbody = tableEl.querySelector('tbody');
				const mo = new MutationObserver(()=> {
					ro.disconnect();
					if(thead) ro.observe(thead);
					tableEl.querySelectorAll('tbody tr').forEach(r=> ro.observe(r));
					requestAnimationFrame(update);
				});
				mo.observe(tbody, { childList: true });

				// quando o wrapper for removido do DOM, desconectar observers (evita leaks)
				const parent = w.parentNode;
				if(parent){
					const parentMo = new MutationObserver((muts)=>{ 
						for(const m of muts){
							for(const n of m.removedNodes){
								if(n === w){
									try{ ro.disconnect(); }catch(_){}
									try{ mo.disconnect(); }catch(_){}
									try{ parentMo.disconnect(); }catch(_){}
									return;
								}
							}
						}
					});
					parentMo.observe(parent, { childList: true });
				}
			})(wrapper);
		});
	}

	// add row after
	function addRowAfter(blockIdx, rowIdx){
		const text = $('editor').value;
		const blocks = splitBlocks(text);
		const blk = blocks[blockIdx] || '';
		const parsed = parseTable(blk);
		const newRow = parsed.headers.map(()=> '');
		if(rowIdx === null || rowIdx === undefined || rowIdx < 0 || rowIdx >= (parsed.rows||[]).length){
			parsed.rows.push(newRow);
		} else {
			parsed.rows.splice(rowIdx + 1, 0, newRow);
		}
		const leading = parsed.leading ? '|' : '';
		const trailing = parsed.trailing ? '|' : '';
		const headerLine = leading + parsed.headers.map(c=>' '+c+' ').join('|') + (trailing? '|':'');
		const sepLine = leading + (parsed.aligns || parsed.headers.map(()=> 'default')).map(a=>{
			if(a==='left') return ':---';
			if(a==='right') return '---:';
			if(a==='center') return ':---:';
			return '---';
		}).map(s=>' '+s+' ').join('|') + (trailing? '|':'');
		const body = (parsed.rows || []).map(r=> leading + r.map(c=>' '+c+' ').join('|') + (trailing? '|':'')).join('\n');
		blocks[blockIdx] = [headerLine, sepLine, body].join('\n');
		saveState(); // Salvar antes de aplicar
		$('editor').value = blocks.join('\n\n');
		renderPreviewFrom($('editor').value);
	}

	// delete row
	function deleteRowAt(blockIdx, rowIdx){
		try{
			const text = $('editor').value;
			const blocks = splitBlocks(text);
			const blk = blocks[blockIdx] || '';
			const parsed = parseTable(blk);
			if(rowIdx>=0 && rowIdx < parsed.rows.length){
				parsed.rows.splice(rowIdx, 1);
				const leading = parsed.leading ? '|' : '';
				const trailing = parsed.trailing ? '|' : '';
				const headerLine = leading + parsed.headers.map(c=>' '+c+' ').join('|') + (trailing? '|':'');
				const sepLine = leading + (parsed.aligns || parsed.headers.map(()=> 'default')).map(a=>{
					if(a==='left') return ':---';
					if(a==='right') return '---:';
					if(a==='center') return ':---:';
					return '---';
				}).map(s=>' '+s+' ').join('|') + (trailing? '|':'');
				const body = parsed.rows.map(r=> leading + r.map(c=>' '+c+' ').join('|') + (trailing? '|':'')).join('\n');
				blocks[blockIdx] = [headerLine, sepLine, body].join('\n');
				saveState(); // Salvar antes de aplicar
				$('editor').value = blocks.join('\n\n');
				currentTableRowIdx = null;
				renderPreviewFrom($('editor').value);
			}
		}catch(e){ console.error(e); }
	}

	// apply block edit (DOM -> markdown)
	function applyBlockEdit(idx, wrapper){
		if(!wrapper.isConnected) return; // Ignorar se foi removido (ex: merge via backspace)
		try{
			const blocks = splitBlocks($('editor').value);
			const newMd = getBlockMarkdown(wrapper);
			blocks[idx] = newMd;
			const out = blocks.join('\n\n');
			if(out !== $('editor').value){ 
				saveState(); // Salvar se houver mudança
				$('editor').value = out; 
				renderPreviewFrom(out); 
			}
		}catch(e){ console.error(e); }
	}

	// modal cell editing
	let editingCell = null;
	function openCellModal(td, blockIdx){
		const modal = $('modal'); const me = $('modalEditor'); if(!modal||!me) return;
		editingCell = {td, blockIdx};
		me.value = td.dataset.hasHtml ? td.innerHTML : td.textContent;
		modal.classList.remove('hidden');
		me.focus();
	}
	function closeCellModal(apply){
		const modal = $('modal'); const me = $('modalEditor'); if(!modal||!me) return;
		if(apply && editingCell){
			const {td, blockIdx} = editingCell;
			const v = me.value;
			
			// Atualizar dataset.md também ao usar o modal
			td.dataset.md = v;

			if(/<\s*(audio|img|video)/i.test(v)){ td.innerHTML = v; td.dataset.hasHtml = '1'; }
			else { td.textContent = v; td.removeAttribute('data-has-html'); }
			const wrapper = $('preview').querySelector(`.block[data-idx="${blockIdx}"]`);
			if(wrapper) applyBlockEdit(blockIdx, wrapper);
		}
		modal.classList.add('hidden');
		editingCell = null;
	}

	// drag & drop: explorer items draggable
	function makeExplorerDraggable(li, relPath){
		li.draggable = true;
		const a = li.querySelector && li.querySelector('a');
		if(a){
			a.draggable = true;
			a.addEventListener('dragstart', (e)=>{
				__dragInfo = null; // garante limpeza de estado (não é reordenação)
				e.dataTransfer.setData('text/plain', relPath);
				e.dataTransfer.effectAllowed = 'copy';
			});
		}
		li.addEventListener('dragstart', (e)=>{
			__dragInfo = null; // garante limpeza de estado
			if(!e.dataTransfer.getData('text/plain')){
				e.dataTransfer.setData('text/plain', relPath);
				e.dataTransfer.effectAllowed = 'copy';
			}
		});
	}

	// enablePreviewDrop: ajustar para distinguir arquivos (externos) vs drags internos (linhas)
	function enablePreviewDrop(){
		const preview = $('preview');
		if(!preview) return;

		// Helper para limpar classes visuais de drop
		const clearDropTargets = () => {
			preview.querySelectorAll('.drop-target').forEach(t=>t.classList.remove('drop-target'));
		};

		// Centraliza dragover
		preview.addEventListener('dragover', (e)=>{
			e.preventDefault();

			// 1. Lógica de Reordenação (se ativo e arrastando linha)
			if(isReorderMode && __dragInfo){
				e.dataTransfer.dropEffect = 'move';
				
				const target = e.target;
				const tbody = target.closest('tbody');
				
				// Se não estiver sobre um corpo de tabela, limpa e retorna
				if(!tbody) {
					clearDropTargets();
					return;
				}

				const rows = Array.from(tbody.querySelectorAll('tr'));
				if(rows.length === 0) return;

				// Limpa alvos anteriores
				clearDropTargets();

				// Calcula índice baseado no Y
				let targetIdx = rows.length - 1;
				for(let i=0; i<rows.length; i++){
					const r = rows[i];
					const rect = r.getBoundingClientRect();
					const mid = rect.top + rect.height/2;
					if(e.clientY < mid){ targetIdx = i; break; }
				}

				// Marca visualmente a linha alvo
				const tgt = rows[targetIdx] || rows[rows.length-1];
				if(tgt) tgt.classList.add('drop-target');
				
				return; // Processado como reorder
			}

			// 2. Lógica de Arquivos (se não for reorder)
			clearDropTargets(); // Garante limpeza visual

			const types = Array.from(e.dataTransfer.types || []);
			const isFiles = types.includes && (types.includes('Files') || types.includes('application/x-moz-file'));
			const isText = types.includes && types.includes('text/plain');
			
			if(isFiles || isText){
				e.dataTransfer.dropEffect = 'copy';
			} else {
				e.dataTransfer.dropEffect = 'none';
			}
		});

		// Limpeza ao sair
		preview.addEventListener('dragleave', (e)=>{
			if(e.relatedTarget && !preview.contains(e.relatedTarget)){
				clearDropTargets();
			}
		});

		// Centraliza drop
		preview.addEventListener('drop', (e)=>{
			e.preventDefault();
			clearDropTargets();

			// 1. Drop de Reordenação
			if(isReorderMode && __dragInfo){
				const target = e.target;
				const tbody = target.closest('tbody');
				if(!tbody) return;

				const rows = Array.from(tbody.querySelectorAll('tr'));
				if(rows.length === 0) return;

				let toIdx = rows.length - 1;
				for(let i=0; i<rows.length; i++){
					const r = rows[i];
					const rect = r.getBoundingClientRect();
					const mid = rect.top + rect.height/2;
					if(e.clientY < mid){ toIdx = i; break; }
				}

				const fromIdx = __dragInfo.rowIdx;
				const blockIdx = __dragInfo.blockIdx;
				
				// Verifica se estamos na mesma tabela (blockIdx)
				const blockEl = tbody.closest('.block');
				if(!blockEl || Number(blockEl.dataset.idx) !== blockIdx) return;

				if(fromIdx === toIdx) return;

				// Executa a troca no markdown
				const parsedLocal = parseTable(splitBlocks($('editor').value)[blockIdx] || '');
				if(!parsedLocal.rows[fromIdx]) return;

				const moved = parsedLocal.rows.splice(fromIdx,1)[0];
				let insertAt = toIdx;
				if(fromIdx < toIdx) insertAt = toIdx;

				parsedLocal.rows.splice(insertAt,0,moved);

				// Reconstrói tabela
				const leading = parsedLocal.leading ? '|' : '';
				const trailing = parsedLocal.trailing ? '|' : '';
				const headerLine = leading + parsedLocal.headers.map(c=>' '+c+' ').join('|') + (trailing? '|':'');
				const sepLine = leading + (parsedLocal.aligns || parsedLocal.headers.map(()=> 'default')).map(a=>{
					if(a==='left') return ':---';
					if(a==='right') return '---:';
					if(a==='center') return ':---:';
					return '---';
				}).map(s=>' '+s+' ').join('|') + (trailing? '|':'');
				const body = parsedLocal.rows.map(r=> leading + r.map(c=>' '+c+' ').join('|') + (trailing? '|':'')).join('\n');
				
				const blocks = splitBlocks($('editor').value);
				blocks[blockIdx] = [headerLine, sepLine, body].join('\n');
				saveState(); // Salvar antes de aplicar reordenação
				$('editor').value = blocks.join('\n\n');
				
				__dragInfo = null;
				renderPreviewFrom($('editor').value);
				return;
			}

			// 2. Drop de Arquivos
			const hasFiles = (e.dataTransfer.files && e.dataTransfer.files.length>0);
			const hasText = e.dataTransfer.getData('text/plain');
			
			if(!hasFiles && !hasText) return;

			const rel = hasText || (e.dataTransfer.files[0] && e.dataTransfer.files[0].name);
			if(!rel) return;
			
			const ext = rel.split('.').pop().toLowerCase();
			let tag = '';
			if(['mp3','wav','ogg','m4a'].includes(ext)) tag = `<audio controls src="${rel}" title="${rel}"></audio>`;
			else if(['png','jpg','jpeg','gif','webp','svg'].includes(ext)) tag = `<img src="${rel}" alt="${rel}" />`;
			else tag = `<!-- ${rel} -->`;

			const rawPanel = $('rawPanel');
			const editor = $('editor');
			const tdEl = e.target && e.target.closest ? e.target.closest('td') : null;
			const blockEl = e.target && e.target.closest ? e.target.closest('.block') : null;
			
			// Se soltou numa célula de tabela
			if(blockEl && blockEl.dataset && blockEl.dataset.type === 'table'){
				const blockIdx = Number(blockEl.dataset.idx);
				let targetCell = tdEl;
				if(!targetCell){
					targetCell = blockEl.querySelector('tbody tr td') || blockEl.querySelector('tbody td');
				}
				if(targetCell){
					if(targetCell.dataset && targetCell.dataset.hasHtml){
						targetCell.innerHTML = targetCell.innerHTML + tag;
					} else {
						targetCell.innerHTML = tag;
					}
					targetCell.dataset.hasHtml = '1';
					applyBlockEdit(blockIdx, blockEl);
					return;
				}
			}

			 // Fallback: inserir no editor/final
			if(editor && rawPanel && !rawPanel.classList.contains('hidden') && document.activeElement === editor){
				insertAtCursor(editor, '\n\n' + tag + '\n');
				renderPreviewFrom(editor.value);
			} else if(editor && rawPanel && !rawPanel.classList.contains('hidden')){
				insertAtCursor(editor, '\n\n' + tag + '\n');
				renderPreviewFrom(editor.value);
			} else if(editor){
				saveState(); // Salvar antes de append direto
				editor.value = editor.value.trim() + '\n\n' + tag + '\n';
				renderPreviewFrom(editor.value);
			} else {
				const container = document.createElement('div'); container.innerHTML = tag; preview.appendChild(container);
			}
		});
	}

	// explorer UI
	function renderExplorerUI(){
		const ul = $('fileList'); ul.innerHTML = '';
		const filterRaw = $('explorerSearch') ? $('explorerSearch').value.trim().toLowerCase() : '';
		if(allFiles.size===0){ const li=document.createElement('li'); li.className='empty'; li.textContent='Nenhum arquivo'; ul.appendChild(li); return; }
		const tree = {};
		for(const k of allFiles.keys()){
			const parts = k.split('/');
			let node = tree;
			for(let i=0; i<parts.length;i++){
				const p = parts[i];
				node.children = node.children || {};
				if(!node.children[p]) node.children[p] = {name:p, children:{}, path: parts.slice(0,i+1).join('/')};
				node = node.children[p];
			}
		}

		function build(node){
			const list = document.createElement('ul');
			list.className = node === tree ? 'root' : 'children';
			let added = 0;
			const children = Object.values(node.children||{}).sort((a,b)=>{
				const aIsFolder = Object.keys(a.children||{}).length > 0;
				const bIsFolder = Object.keys(b.children||{}).length > 0;
				if(aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
				return a.name.localeCompare(b.name,'pt',{numeric:true});
			});
			for(const ch of children){
				const isFolder = Object.keys(ch.children||{}).length > 0;
				if(isFolder){
					// construir sublista e só anexar se tiver itens visíveis
					const sub = build(ch);
					if(sub && sub.childElementCount > 0){
						const li = document.createElement('li');
						
						// Lógica de expansão: se estiver filtrando, expande tudo para mostrar resultados.
						// Se não, respeita o estado salvo em expandedPaths.
						const isSearching = filterRaw.length > 0;
						const isExpanded = isSearching || expandedPaths.has(ch.path);
						
						li.className = isExpanded ? 'folder' : 'folder collapsed';
						
						const row = document.createElement('div'); row.className = 'folder-row';
						const btn = document.createElement('button'); btn.type='button'; btn.className='folder-toggle'; 
						btn.setAttribute('aria-expanded', String(isExpanded));
						btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 5l8 7-8 7"/></svg>';
						
						const toggleFn = (e) => {
							e.stopPropagation();
							li.classList.toggle('collapsed');
							const expanded = !li.classList.contains('collapsed');
							btn.setAttribute('aria-expanded', String(expanded));
							if(expanded) expandedPaths.add(ch.path);
							else expandedPaths.delete(ch.path);
						};

						btn.addEventListener('click', toggleFn);
						row.appendChild(btn);
						const span = document.createElement('div'); span.className='folder-label';
						const icon = document.createElement('span'); icon.className='folder-icon';
						icon.textContent = '📁';
						const text = document.createElement('span'); text.textContent = ch.name;
						span.appendChild(icon); span.appendChild(text);
						span.addEventListener('click', toggleFn);
						row.appendChild(span);
						li.appendChild(row);
						li.appendChild(sub);
						list.appendChild(li);
						added++;
					}
				} else {
					// arquivo (leaf) — aplicar filtro
					const nameLower = (ch.name||'').toLowerCase();
					const pathLower = (ch.path||'').toLowerCase();
					if(filterRaw && !(nameLower.includes(filterRaw) || pathLower.includes(filterRaw))) {
						continue;
					}
					const li = document.createElement('li');
					const a = document.createElement('a');
					a.className = 'file-link';
					a.href = '#';
					a.dataset.path = ch.path;
					const icon = document.createElement('span'); icon.className='file-icon';
					const ext = (ch.name.split('.').pop()||'').toLowerCase();
					if(['mp3','wav','ogg','m4a'].includes(ext)) icon.textContent = '🎵';
					else if(['png','jpg','jpeg','gif','webp','svg'].includes(ext)) icon.textContent = '🖼️';
					else if(ext === 'md') icon.textContent = '📄';
					else icon.textContent = '📦';
					const nameSpan = document.createElement('span'); nameSpan.className='name'; nameSpan.textContent = ch.name;
					a.appendChild(icon); a.appendChild(nameSpan);
					a.addEventListener('click', e=>{ e.preventDefault(); if(ch.path.endsWith('.md')) openMd(ch.path); });
					
					// Novo: Listeners para Hover Preview
					a.addEventListener('mouseenter', () => {
						if (__previewTimer) clearTimeout(__previewTimer);
						// Se já estiver mostrando outro, fecha
						if(__currentPreviewPath && __currentPreviewPath !== ch.path) hidePreviewPopup();
						// Inicia timer de 2 segundos
						__previewTimer = setTimeout(() => showPreviewPopup(a, ch.path), 500);
					});
					a.addEventListener('mouseleave', () => {
						if (__previewTimer) clearTimeout(__previewTimer);
						hidePreviewPopup();
					});
					a.addEventListener('mousedown', () => {
						hidePreviewPopup(); // Fecha imediatamente ao clicar
						});

					li.appendChild(a);
					makeExplorerDraggable(li, ch.path);
					a.addEventListener('contextmenu', (ev)=>{ ev.preventDefault(); ev.stopPropagation(); showExplorerContextMenu(ev.clientX, ev.clientY, ch.path); });
					list.appendChild(li);
					added++;
				}
			}
			return added > 0 ? list : null;
		}

		const built = build(tree);
		if(built) ul.appendChild(built);
		else { const li=document.createElement('li'); li.className='empty'; li.textContent='Nenhum arquivo'; ul.appendChild(li); }

		async function openMd(path){
			let f = allFiles.get(path);
			if(!f) return;

			// Lazy Load para GitHub: se o arquivo estiver vazio (dummy), baixar conteúdo
			if(gitHubRepoData && f.size === 0){
				// Alterado: Usar API de Contents com Header RAW para suportar repos privados
				const apiUrl = getGitHubApiContentUrl(path);
				try {
					$('editor').value = 'Carregando do GitHub...';
					renderPreviewFrom('Carregando...');
					
					// Usa ghFetch para incluir token se existir
					const res = await ghFetch(apiUrl, {
						headers: { 'Accept': 'application/vnd.github.raw' }
					});
					
					if(!res.ok) throw new Error('HTTP ' + res.status);
					const txt = await res.text();
					// Atualizar o arquivo no mapa com o conteúdo real
					f = new File([txt], path.split('/').pop(), {type: 'text/markdown'});
					allFiles.set(path, f);
					if(/\.md$/i.test(path)) mdFiles.set(path, f);
				} catch(e) {
					alert('Erro ao baixar arquivo do GitHub: ' + e.message);
					$('editor').value = '';
					renderPreviewFrom('');
					return;
				}
			}

			const r = new FileReader();
			r.onload = ()=>{ $('editor').value = String(r.result); currentName = path; $('currentFilename').textContent = currentName; renderPreviewFrom($('editor').value); };
			r.readAsText(f);
		}
	}
	
	// save helpers (File System Access + IndexedDB)
	async function writeToHandle(handle, content){
		const writable = await handle.createWritable();
		await writable.write(content);
		await writable.close();
	}
	async function saveContentAs(suggestedName, content){
		if(window.showSaveFilePicker){
			const opts = {
				suggestedName: suggestedName || 'untitled.md',
				types: [{ description: 'Markdown', accept: {'text/markdown': ['.md','.markdown','.txt']} }]
			};
			const handle = await window.showSaveFilePicker(opts);
			await writeToHandle(handle, content);
			persistentFileHandle = handle;
			try{ await saveHandleToDB(handle); }catch(e){ console.warn('saveHandleToDB failed', e); }
			return true;
		}
		return false;
	}
	async function openHandlesDB(){
		return new Promise((resolve, reject)=>{
			const req = indexedDB.open('ez2-handles', 1);
			req.onupgradeneeded = ()=>{ const db = req.result; if(!db.objectStoreNames.contains('handles')) db.createObjectStore('handles'); };
			req.onsuccess = ()=> resolve(req.result);
			req.onerror = ()=> reject(req.error);
		});
	}
	async function saveHandleToDB(handle){
		try{
			const db = await openHandlesDB();
			const tx = db.transaction('handles','readwrite');
			tx.objectStore('handles').put(handle, 'file');
			return tx.complete ? await tx.complete : true;
		}catch(e){ console.warn('saveHandleToDB falhou', e); }
	}
	async function getHandleFromDB(){
		try{
			const db = await openHandlesDB();
			return new Promise((resolve, reject)=>{
				const tx = db.transaction('handles','readonly');
				const req = tx.objectStore('handles').get('file');
				req.onsuccess = ()=> resolve(req.result);
				req.onerror = ()=> reject(req.error);
			});
		}catch(e){ console.warn('getHandleFromDB falhou', e); return null; }
	}
	async function verifyPermission(handle){
		if(!handle) return false;
		if(handle.queryPermission){
			let p = await handle.queryPermission({mode:'readwrite'});
			if(p === 'granted') return true;
			p = await handle.requestPermission({mode:'readwrite'});
			return p === 'granted';
		}
		return false;
	}

	// --- UI: barra de progresso e prompt de conexão ---
	function showSaveProgress(text){
		const el = $('saveProgress'); if(!el) return;
		const bar = el.querySelector('.save-progress-bar'); const txt = el.querySelector('.save-progress-text');
		if(txt) txt.textContent = text || 'Salvando...';
		el.classList.remove('hidden'); el.setAttribute('aria-hidden','false');
		// animação: começar pequeno e progredir até ~80% enquanto a operação ocorre
		if(bar) bar.style.setProperty('--progress', '0%');
		updateProgressTo(20);
	}
	function updateProgressTo(percent){
		const el = $('saveProgress'); if(!el) return;
		const bar = el.querySelector('.save-progress-bar');
		if(!bar) return;
		// usa pseudo-elemento ::after; ajustar via style.setProperty não funciona em pseudo, então ajustamos width do ...after via inline style alterando data-atributo
		bar.style.setProperty('--pwidth', percent + '%');
		// fallback: aplicar diretamente no ::after simulando com transform using CSS variable -> simpler: set inline child
		let inner = bar.querySelector('.__inner');
		if(!inner){ inner = document.createElement('div'); inner.className='__inner'; inner.style.position='absolute'; inner.style.left='0'; inner.style.top='0'; inner.style.bottom='0'; inner.style.width='0%'; inner.style.background='linear-gradient(90deg,var(--accent),#3e8fed)'; inner.style.borderRadius='6px'; inner.style.transition='width 240ms linear'; bar.appendChild(inner); }
		inner.style.width = percent + '%';
	}
	function hideSaveProgress(){
		const el = $('saveProgress'); if(!el) return;
		const bar = el.querySelector('.save-progress-bar');
		if(bar){
			const inner = bar.querySelector('.__inner');
			if(inner) inner.style.width = '0%';
		}
		el.classList.add('hidden');
		el.setAttribute('aria-hidden','true');
	}

	// --- Prompt de conexão (quando servidor local não está disponível) ---
	function showConnectPrompt(){
		const cp = $('connectPrompt');
		if(!cp) return;
		cp.classList.remove('hidden');
		cp.setAttribute('aria-hidden','false');
	}

	function hideConnectPrompt(){
		const cp = $('connectPrompt');
		if(!cp) return;
		cp.classList.add('hidden');
		cp.setAttribute('aria-hidden','true');
	}

	// Conectar botões do prompt de conexão
	document.addEventListener('DOMContentLoaded', () => {
		const cpConnect = $('cpConnectBtn');
		const cpCancel = $('cpCancelBtn');
		if(cpConnect){
			cpConnect.addEventListener('click', async ()=>{
				hideConnectPrompt();
				// dispara o fluxo existente de conectar (reaproveita botão principal)
				const el = $('connStatus');
				if(el) el.click();
			});
		}
		if(cpCancel){
			cpCancel.addEventListener('click', ()=> hideConnectPrompt());
		}
	});

	// init
	function init(){
		const openBtn = $('openBtn'), folderInput = $('folderInput'), preview = $('preview');
		enablePreviewDrop();

		// open folder
		// abrir pasta via input do navegador (não aciona mais o seletor do Python)
		openBtn.addEventListener('click', ()=> {
			folderInput.click();
		});

		// GitHub Open Button
		const openGhBtn = $('openGhBtn');
		if(openGhBtn){
			openGhBtn.addEventListener('click', async ()=>{
				const repo = prompt('Digite o repositório (ex: usuario/repo):', 'microsoft/vscode-docs');
				if(!repo) return;
				const parts = repo.split('/');
				if(parts.length < 2) return alert('Formato inválido. Use usuario/repo');
				
				const owner = parts[0].trim();
				const repoName = parts[1].trim();
				
				try {
					// 1. Obter info do repo para saber branch default
					// Alterado: usar ghFetch
					const infoRes = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}`);
					if(!infoRes.ok) {
						if(infoRes.status === 404) throw new Error('Repositório não encontrado ou acesso negado (verifique o Token).');
						throw new Error('Erro API: ' + infoRes.status);
					}
					const info = await infoRes.json();
					const branch = info.default_branch || 'main';

					// 2. Obter árvore de arquivos recursiva
					// Alterado: usar ghFetch
					const treeRes = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`);
					if(!treeRes.ok) throw new Error('Erro ao ler arquivos.');
					const treeData = await treeRes.json();

					// 3. Resetar estado
					revokeObjectUrls(); allFiles.clear(); mdFiles.clear(); expandedPaths.clear();
					gitHubRepoData = { owner, repo: repoName, branch };

					// 4. Popular allFiles com arquivos "dummy" (vazios)
					// O conteúdo será baixado sob demanda em openMd
					let count = 0;
					for(const item of treeData.tree){
						if(item.type === 'blob'){
							const path = item.path;
							// Criar arquivo vazio apenas para constar na lista
							const dummy = new File([], path.split('/').pop());
							allFiles.set(path, dummy);
							if(/\.md$/i.test(path)) mdFiles.set(path, dummy);
							count++;
						}
					}
					
					renderExplorerUI();
					alert(`Repositório carregado: ${count} arquivos.`);

				} catch(e){
					console.error(e);
					alert('Erro ao carregar GitHub: ' + e.message);
				}
			});
		}

		// GitHub Login Logic
		const ghLoginBtn = $('ghLoginBtn');
		const ghLoginModal = $('ghLoginModal');
		const ghLoginClose = $('ghLoginClose');
		const ghLoginSave = $('ghLoginSave');
		const ghLogoutBtn = $('ghLogoutBtn');
		const ghTokenInput = $('ghTokenInput');

		function updateGhLoginUI(){
			if(gitHubToken){
				ghLoginBtn.classList.add('logged-in');
				ghLoginBtn.title = "Logado no GitHub";
				ghLogoutBtn.style.display = 'block';
				ghTokenInput.value = ''; // não mostrar token salvo por segurança visual
				ghTokenInput.placeholder = 'Token salvo (oculto)';
			} else {
				ghLoginBtn.classList.remove('logged-in');
				ghLoginBtn.title = "Configurar Token GitHub";
				ghLogoutBtn.style.display = 'none';
				ghTokenInput.placeholder = 'ghp_...';
			}
		}
		
		// Init UI
		updateGhLoginUI();

		if(ghLoginBtn) ghLoginBtn.addEventListener('click', ()=> {
			ghLoginModal.classList.remove('hidden');
			ghTokenInput.focus();
		});
		
		if(ghLoginClose) ghLoginClose.addEventListener('click', ()=> ghLoginModal.classList.add('hidden'));
		
		if(ghLoginSave) ghLoginSave.addEventListener('click', async ()=>{
			const val = ghTokenInput.value.trim();
			if(!val && !gitHubToken) return alert('Insira um token.');
			
			if(val){
				// Validar token simples (chamada user)
				try {
					ghLoginSave.textContent = 'Verificando...';
					const res = await fetch('https://api.github.com/user', {
						headers: { 'Authorization': `Bearer ${val}` }
					});
					if(!res.ok) throw new Error('Token inválido');
					const user = await res.json();
					
					gitHubToken = val;
					localStorage.setItem('ez2_gh_token', val);
					updateGhLoginUI();
					ghLoginModal.classList.add('hidden');
					alert(`Logado como: ${user.login}`);
				} catch(e) {
					alert('Erro ao validar token: ' + e.message);
				} finally {
					ghLoginSave.textContent = 'Salvar Token';
				}
			} else {
				ghLoginModal.classList.add('hidden');
			}
		});

		if(ghLogoutBtn) ghLogoutBtn.addEventListener('click', ()=>{
			if(confirm('Remover token salvo?')){
				gitHubToken = null;
				localStorage.removeItem('ez2_gh_token');
				updateGhLoginUI();
				ghLoginModal.classList.add('hidden');
			}
		});

		// open folder (input fallback)
		folderInput.addEventListener('change', (e)=>{
			revokeObjectUrls(); allFiles.clear(); mdFiles.clear(); expandedPaths.clear();
			gitHubRepoData = null; // resetar modo GitHub
			Array.from(e.target.files||[]).forEach(f=>{ const rel = f.webkitRelativePath||f.name; allFiles.set(rel,f); if(/\.md$/i.test(f.name)) mdFiles.set(rel,f); });
			renderExplorerUI(); folderInput.value = '';
		});

		// botão reordenar
		const reorderBtn = $('reorderBtn');
		if(reorderBtn){
			reorderBtn.addEventListener('click', ()=>{
				isReorderMode = !isReorderMode;
				const preview = $('preview');
				if(isReorderMode){
					reorderBtn.classList.add('active');
					preview.classList.add('reorder-mode');
				} else {
					reorderBtn.classList.remove('active');
					preview.classList.remove('reorder-mode');
				}
			});
		}

		// botão toggle audio
		const toggleAudioBtn = $('toggleAudioBtn');
		if(toggleAudioBtn){
			// estado inicial
			if(isAudioEnabled) toggleAudioBtn.classList.add('active');
			
			toggleAudioBtn.addEventListener('click', ()=>{
				isAudioEnabled = !isAudioEnabled;
				if(isAudioEnabled) toggleAudioBtn.classList.add('active');
				else toggleAudioBtn.classList.remove('active');
				// Re-renderizar para aplicar mudança (carregar ou descarregar blobs)
				renderPreviewFrom($('editor').value);
			});
		}

		// raw panel toggle
		const toggleRawBtn = $('toggleRawBtn'), rawPanel = $('rawPanel'), rawApply=$('rawApply'), rawClose=$('rawClose'), rawCancel=$('rawCancel'), rawCopy=$('rawCopy');
		if(toggleRawBtn) toggleRawBtn.addEventListener('click', ()=> {
			if(rawPanel.classList.contains('hidden')) saveState(); // Salvar ao abrir editor bruto
			rawPanel.classList.toggle('hidden');
		});
		if(rawClose) rawClose.addEventListener('click', ()=> rawPanel.classList.add('hidden'));
		if(rawApply) rawApply.addEventListener('click', ()=> { renderPreviewFrom($('editor').value); rawPanel.classList.add('hidden'); });
		if(rawCancel) rawCancel.addEventListener('click', ()=> rawPanel.classList.add('hidden'));
		// Novo: botão copiar
		if(rawCopy) rawCopy.addEventListener('click', async ()=>{
			try{
				await navigator.clipboard.writeText($('editor').value);
				const old = rawCopy.textContent; rawCopy.textContent = 'Copiado!';
				setTimeout(()=> rawCopy.textContent = old, 1500);
			}catch(e){ console.error(e); }
		});

		// modal handlers
		const modal = $('modal'), modalApply=$('modalApply'), modalClose=$('modalClose'), modalCancel=$('modalCancel');
		if(modalClose) modalClose.addEventListener('click', ()=> closeCellModal(false));
		if(modalApply) modalApply.addEventListener('click', ()=> closeCellModal(true));
		if(modalCancel) modalCancel.addEventListener('click', ()=> closeCellModal(false));
		if(modal) modal.addEventListener('click', (e)=>{ if(e.target===modal) closeCellModal(false); });

		// collapse sidebar
		const collapseBtn = $('collapseBtn');
		if(collapseBtn){
			collapseBtn.addEventListener('click', ()=>{
				const appEl = $('app');
				const sidebar = document.querySelector('.sidebar');
				if(!appEl || !sidebar) return;
				const willCollapse = !appEl.classList.contains('sidebar-collapsed');
				if(willCollapse){
					const w = sidebar.getBoundingClientRect().width;
					lastSidebarWidth = Math.max(56, Math.round(w));
					sidebar.style.width = '';
					appEl.classList.add('sidebar-collapsed');
					collapseBtn.textContent = '⇥';
				} else {
					appEl.classList.remove('sidebar-collapsed');
					if(lastSidebarWidth) sidebar.style.width = String(lastSidebarWidth) + 'px';
					else sidebar.style.width = '';
					collapseBtn.textContent = '⇤';
				}
			});
		}

		// resizer
		const resizer = $('sidebarResizer');
		if(resizer){
			resizer.style.touchAction = 'none';
			let dragging = false, startX = 0, startWidth = 0;
			const sidebar = document.querySelector('.sidebar');
			const appEl = $('app');
			const minWidth = 120, maxWidth = 640;
			resizer.addEventListener('mousedown', e=>{
				if(appEl && appEl.classList.contains('sidebar-collapsed')){
					appEl.classList.remove('sidebar-collapsed');
					startWidth = lastSidebarWidth || sidebar.getBoundingClientRect().width || 220;
					sidebar.style.width = startWidth + 'px';
				} else startWidth = sidebar.getBoundingClientRect().width;
				dragging = true; startX = e.clientX;
				if(appEl) appEl.classList.add('sidebar-resizing');
				document.body.style.userSelect = 'none';
			});
			window.addEventListener('mousemove', e=>{
				if(!dragging) return;
				const dx = e.clientX - startX;
				let newWidth = Math.round(startWidth + dx);
				newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
				sidebar.style.width = newWidth + 'px';
			});
			window.addEventListener('mouseup', ()=>{
				if(!dragging) return;
				dragging = false;
				if(appEl) appEl.classList.remove('sidebar-resizing');
				document.body.style.userSelect = '';
				const ed = $('editor'); if(ed) ed.blur();
				try{ lastSidebarWidth = Math.round(sidebar.getBoundingClientRect().width); }catch(e){}
			});
			// touch
			resizer.addEventListener('touchstart', e=>{
				const t = e.touches[0];
				if(appEl && appEl.classList.contains('sidebar-collapsed')){
					appEl.classList.remove('sidebar-collapsed');
					startWidth = lastSidebarWidth || sidebar.getBoundingClientRect().width || 220;
					sidebar.style.width = startWidth + 'px';
				} else startWidth = sidebar.getBoundingClientRect().width;
				dragging = true; startX = t.clientX;
				if(appEl) appEl.classList.add('sidebar-resizing');
						});
			window.addEventListener('touchmove', e=>{
				if(!dragging) return;
				const t = e.touches[0];
				const dx = t.clientX - startX;
				let newWidth = Math.round(startWidth + dx);
				newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
				sidebar.style.width = newWidth + 'px';
			});
			window.addEventListener('touchend', ()=>{
				if(!dragging) return;
				dragging = false;
				if(appEl) appEl.classList.remove('sidebar-resizing');
				try{ lastSidebarWidth = Math.round(sidebar.getBoundingClientRect().width); }catch(e){}
			});
		}

		// atalhos de teclado continuam usando Conn, sem botão
		window.addEventListener('keydown', (e)=>{
			if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='o'){
				e.preventDefault();
				folderInput.click();
			}
			if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
				e.preventDefault();
				(async ()=>{
					const content = $('editor').value;
					const up = await Conn.ping();
					// se ping falhar OU servidor estiver pausado (não respondendo), trata como desconectado
					if(!up){
						const cpBody = $('connectPrompt') && $('connectPrompt').querySelector('.cp-body');
						if(cpBody) cpBody.textContent =
							'Servidor local indisponível. Deseja salvar localmente usando o navegador ou conectar ao servidor?';
						showConnectPrompt();
						return;
					}
					const pathToSave = resolveSaveTargetName();
					try{
						showSaveProgress('Salvando via servidor local...');
						const progTicker = setInterval(()=>{
							const el = $('saveProgress'); if(!el) return;
							const bar = el.querySelector('.save-progress-bar .__inner');
							if(!bar) return;
							const cur = parseFloat(bar.style.width) || 0;
							bar.style.width = Math.min(85, cur + (Math.random()*6)) + '%';
						}, 200);
						await Conn.save(prepareLocalSavePath(pathToSave), content);
						clearInterval(progTicker);
						updateProgressTo(100);
						setTimeout(()=> hideSaveProgress(), 450);
						currentName = pathToSave;
						$('currentFilename').textContent = currentName;
						await Conn.fetchInfo();
						updateConnectionIndicator();
					}catch(err){
						hideSaveProgress();
						console.warn('Erro ao salvar via Conn.save', err);
						const cpBody = $('connectPrompt') && $('connectPrompt').querySelector('.cp-body');
						if(cpBody) cpBody.textContent =
							'Erro ao salvar via servidor local: ' + (err && err.message ? err.message : 'ver console');
						showConnectPrompt();
					}
				})();
			}
			
			// Undo / Redo
			if((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z'){
				// Se o raw panel estiver visível e focado no textarea, deixa o nativo
				if(!$('rawPanel').classList.contains('hidden') && document.activeElement === $('editor')) return;
				e.preventDefault();
				undo();
			}
			if((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))){
				if(!$('rawPanel').classList.contains('hidden') && document.activeElement === $('editor')) return;
				e.preventDefault();
				redo();
			}

			// ...existing outros atalhos...
		});

		// tentar restaurar handle salvo
		(async ()=>{
			try{
				const saved = await getHandleFromDB();
				if(saved){
					if(await verifyPermission(saved)){ persistentFileHandle = saved; console.info('Handle restaurado e com permissão.'); }
					else { persistentFileHandle = saved; console.info('Handle restaurado sem permissão de escrita.'); }
				}
			}catch(e){ console.warn('Erro ao restaurar handle:', e); }
		})();

		// sample
		const sample = `# Bem-vindo ao EZ2 Markdown

Este é o preview principal. Use o olho (canto superior direito) para abrir o editor bruto.

| Nome | Nota |
|:-----|-----:|
| João | 10 |
`;
		$('editor').value = sample;
		renderPreviewFrom(sample);
		createContextMenu(); // preparar menu

		// conectar busca do explorer AQUI (elemento já existe)
		(function connectExplorerSearchInsideInit(){
			const s = $('explorerSearch');
			if(!s) return;
			let tmo = null;
			s.addEventListener('input', ()=>{
				if(tmo) clearTimeout(tmo);
				tmo = setTimeout(()=>{ renderExplorerUI(); }, 150);
			});
		})();

		// no init(): iniciar Conn.startPingLoop(updateConnectionIndicator)
		// localizar o trecho init() e, logo depois de criar connectLocalBtn e fazer tentativa inicial,
		// chamar Conn.startPingLoop(updateConnectionIndicator)
		Conn.startPingLoop(updateConnectionIndicator);
	}

	// expose $
	window.$ = $;

	// init on DOM ready
	if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
	else init();

	// expose debug
	window.EZ2 = { renderPreviewFrom, revokeObjectUrls, allFiles };

	// inserir, logo após a definição de init(), a chamada para iniciar o loop de ping
	(function startConnectionMonitoring(){
		// começar monitoramento assim que DOM estiver pronto
		if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', ()=> Conn.startPingLoop(updateConnectionIndicator));
		else Conn.startPingLoop(updateConnectionIndicator);
	})();

	// end
})();
