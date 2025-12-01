"""
Servidor local de exemplo para receber pedidos de gravação do EZ2.
Instale dependências: pip install flask
Execute:
    python local_server.py --host 127.0.0.1 --port 53423 --base "C:\\Users\\Você\\Documents\\minhaPasta"
Observação: este é um servidor de demonstração. Use com cuidado (não expôr na internet).
Nota: erros de PermissionError durante o build com PyInstaller (por exemplo, ao apagar dist\\Module)
normalmente são causados por arquivos ainda em uso, não por este código.
"""
from flask import Flask, request, jsonify, send_from_directory, send_file
import argparse, os, json
from pathlib import Path

# Importação explícita para garantir que o PyInstaller inclua o módulo
try:
    import werkzeug.serving  # noqa: F401
except Exception:
    # se não existir em tempo de execução, deixamos seguir (Flask acusará se precisar)
    pass

import threading
# import webbrowser  # não é mais usado para "Abrir"
import sys
import time
import platform

# imports opcionais usados apenas no Windows/tray
try:
	from PIL import Image, ImageDraw
	import pystray
except Exception:
	# se não instalados, ainda funciona sem tray (vai imprimir URL)
	pystray = None

# usado para tentar esconder a janela do console no Windows
try:
	import ctypes
except Exception:
	ctypes = None

app = Flask(__name__)
BASE_FOLDER = None
SERVER_PAUSED = False  # indica se o servidor está pausado (não será mais usado para bloquear rotas)
SERVER_RUNNING = False  # indica se o servidor Flask está rodando
server_thread = None    # referência para a thread do servidor

# caminho do config.json ao lado do script/exe
CONFIG_PATH = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent)).parent / 'config.json'


def load_config_base():
    """Carrega BASE_FOLDER de config.json, se existir e for válida."""
    global BASE_FOLDER
    try:
        if CONFIG_PATH.is_file():
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            base = data.get('base')
            if base and os.path.isdir(base):
                BASE_FOLDER = str(Path(base).resolve())
                print('Base carregada de config.json:', BASE_FOLDER)
    except Exception as e:
        print('Falha ao carregar config.json:', e)


def save_config_base():
    """Salva BASE_FOLDER atual em config.json."""
    global BASE_FOLDER
    try:
        if not BASE_FOLDER:
            return
        data = {"base": BASE_FOLDER}
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print('Falha ao salvar config.json:', e)


def safe_join_base(p):
    global BASE_FOLDER
    if os.path.isabs(p):
        target = Path(p).resolve()
        if BASE_FOLDER:
            base = Path(BASE_FOLDER).resolve()
            try:
                target.relative_to(base)
            except Exception:
                # caminho absoluto fora da base -> proibido
                return None
            return target
        # se base não definida, aceitar absoluto
        return target
    else:
        if not BASE_FOLDER:
            return None
        return Path(BASE_FOLDER).joinpath(p).resolve()

def list_all_files(base):
    out = []
    basep = Path(base)
    for p in basep.rglob('*'):
        if p.is_file():
            rel = str(p.relative_to(basep).as_posix())
            out.append(rel)
    out.sort()
    return out

def check_paused():
    """Mantida por compatibilidade, mas não bloqueia mais as rotas."""
    return None

@app.after_request
def add_cors(response):
    # permitir chamadas cross-origin (GitHub Pages -> localhost)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

@app.route('/ping', methods=['GET', 'OPTIONS'])
def ping():
    if request.method == 'OPTIONS':
        return ('', 204)
    # se ?short=1, responder mínimo possível
    short = request.args.get('short') in ('1', 'true', 'yes')
    if short:
        return ('ok', 200)
    return jsonify({"ok": True, "msg": "pong"})

@app.route('/info', methods=['GET', 'OPTIONS'])
def info():
    if request.method == 'OPTIONS': return ('', 204)
    # expor também se o servidor Flask está rodando (SERVER_RUNNING)
    return jsonify({
        "ok": True,
        "base": BASE_FOLDER,
        "running": SERVER_RUNNING
    })

@app.route('/setbase', methods=['POST', 'OPTIONS'])
def setbase():
    global BASE_FOLDER
    if request.method == 'OPTIONS': return ('', 204)
    data = request.get_json(silent=True) or {}
    b = data.get('base') or data.get('path')
    if not b:
        return jsonify({"ok": False, "error": "campo 'base' ausente"}), 400
    if not os.path.isdir(b):
        return jsonify({"ok": False, "error": "pasta não existe: "+str(b)}), 400
    BASE_FOLDER = str(Path(b).resolve())
    save_config_base()
    return jsonify({"ok": True, "base": BASE_FOLDER})

@app.route('/save', methods=['POST', 'OPTIONS'])
def save():
    if request.method == 'OPTIONS': return ('', 204)
    # NÃO usa mais check_paused aqui, pausa = servidor desligado de verdade
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "error": "payload inválido"}), 400
    path = data.get('path')
    content = data.get('content', '')
    if not path:
        return jsonify({"ok": False, "error": "campo 'path' ausente"}), 400

    # novo: só permitir arquivos markdown (.md / .markdown)
    lower = str(path).lower()
    if not (lower.endswith('.md') or lower.endswith('.markdown')):
        return jsonify({"ok": False, "error": "somente arquivos Markdown (.md/.markdown) são permitidos"}), 400

    target = safe_join_base(path)
    if target is None:
        return jsonify({"ok": False, "error": "caminho fora da base ou base não configurada"}), 400
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        return jsonify({"ok": True, "saved": str(target)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/pick', methods=['POST', 'OPTIONS'])
def pick():
    """
    Abre um seletor de pasta no desktop (tkinter.askdirectory), guarda BASE_FOLDER e retorna apenas a base.
    """
    global BASE_FOLDER
    if request.method == 'OPTIONS': return ('', 204)
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        path = filedialog.askdirectory()
        root.destroy()
        if not path:
            return jsonify({"ok": False, "error": "cancelled"}), 400
        if not os.path.isdir(path):
            return jsonify({"ok": False, "error": "pasta inválida"}), 400
        BASE_FOLDER = str(Path(path).resolve())
        save_config_base()
        # retorno simplificado: só a base (sem listar arquivos)
        return jsonify({"ok": True, "base": BASE_FOLDER})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/list', methods=['GET', 'OPTIONS'])
def list_route():
    if request.method == 'OPTIONS': return ('', 204)
    # não usa mais check_paused
    if not BASE_FOLDER:
        return jsonify({"ok": False, "error": "base não configurada"}), 400
    files = list_all_files(BASE_FOLDER)
    return jsonify({"ok": True, "base": BASE_FOLDER, "files": files})

@app.route('/file', methods=['GET', 'OPTIONS'])
def serve_file():
    if request.method == 'OPTIONS': return ('', 204)
    # não usa mais check_paused
    rel = request.args.get('path') or request.args.get('p')
    if not rel:
        return jsonify({"ok": False, "error": "path ausente"}), 400
    target = safe_join_base(rel)
    if target is None or not target.exists() or not target.is_file():
        return jsonify({"ok": False, "error": "arquivo não encontrado ou fora da base"}), 404
    try:
        return send_file(str(target), as_attachment=False)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/__shutdown', methods=['POST'])
def __shutdown():
    """
    Rota de auxílio para encerrar o servidor (usada pelo menu da tray).
    """
    if request.method == 'OPTIONS':
        return ('', 204)
    func = request.environ.get('werkzeug.server.shutdown')
    if func is None:
        return jsonify({"ok": False, "error": "shutdown não disponível"}), 500
    func()
    return jsonify({"ok": True, "msg": "shutting down"})

if __name__ == '__main__':
    # carregar base do config.json antes de processar args
    load_config_base()

    # Observação: erros de acesso negado do PyInstaller ao limpar a pasta dist
    # geralmente indicam que um .exe antigo ainda está rodando ou travado por antivírus.
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=53423, type=int)
    parser.add_argument('--base', default=None)
    parser.add_argument('--tls-cert', default=None, help='Caminho para arquivo PEM do certificado (opcional, ativa HTTPS)')
    parser.add_argument('--tls-key', default=None, help='Caminho para arquivo PEM da chave privada (opcional, ativa HTTPS)')
    args = parser.parse_args()
    if args.base:
        if os.path.isdir(args.base):
            BASE_FOLDER = str(Path(args.base).resolve())
            save_config_base()
        else:
            print('base não existe:', args.base)
            BASE_FOLDER = None
    use_tls = False
    ssl_context = None
    if getattr(args, 'tls_cert', None) and getattr(args, 'tls_key', None):
        cert = args.tls_cert
        key = args.tls_key
        if os.path.isfile(cert) and os.path.isfile(key):
            ssl_context = (cert, key)
            use_tls = True
        else:
            print('Aviso: caminhos de certificado/chave inválidos — iniciando sem TLS.')

    proto = 'https' if use_tls else 'http'
    url = f'{proto}://{args.host}:{args.port}'
    print(f'Servidor local iniciado em {url} (base={BASE_FOLDER})')

    # função para rodar Flask em thread de fundo
    def run_server():
        global SERVER_RUNNING
        try:
            SERVER_RUNNING = True
            app.run(
                host=args.host,
                port=args.port,
                debug=False,
                ssl_context=ssl_context,
                use_reloader=False,
            )
        except Exception as e:
            print('Servidor finalizado:', e)
        finally:
            SERVER_RUNNING = False

    def start_flask_server():
        """Inicia o servidor Flask em background se não estiver rodando."""
        global server_thread, SERVER_RUNNING
        if SERVER_RUNNING:
            return
        server_thread = threading.Thread(target=run_server, daemon=True)
        server_thread.start()

    # iniciar servidor em background (estado inicial: ligado)
    start_flask_server()

    # esconder console no Windows (opcional) -> desativado para manter o CMD visível
    # if platform.system().lower().startswith('win') and ctypes is not None:
    #     try:
    #         ctypes.windll.user32.ShowWindow(ctypes.windll.kernel32.GetConsoleWindow(), 0)  # 0 = SW_HIDE
    #     except Exception:
    #         pass

    # se pystray estiver disponível, criar ícone na bandeja; caso contrário, apenas abrir URL e aguardar
    def start_tray():
        if pystray is None:
            print('pystray/Pillow não instalados — rodando sem ícone na tray. Abra:', url)
            try:
                while True:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                try:
                    import requests
                    requests.post(f'{url}/__shutdown', timeout=1)
                except Exception:
                    pass
            return

        # callbacks do menu
        # def open_url(icon, item):
        #     """
        #     Abrir um novo CMD mostrando o log do app.
        #     """
        #     # ...existing (agora removido/desativado)...

        def quit_app(icon, item):
            # tentar pedir para o servidor encerrar
            try:
                import requests
                requests.post(f'{url}/__shutdown', timeout=1)
            except Exception:
                pass
            # parar o ícone
            try:
                icon.stop()
            except Exception:
                pass
            # pequena espera para a thread do servidor encerrar
            time.sleep(0.5)

            # forçar encerramento do processo (inclui todas as threads)
            os._exit(0)

        def toggle_pause(icon, item):
            """Desliga/religa o servidor Flask de verdade e atualiza o texto do menu."""
            global SERVER_PAUSED, SERVER_RUNNING, server_thread
            try:
                import requests
            except Exception:
                requests = None

            if SERVER_RUNNING:
                # desligar servidor
                print('Pausando servidor (desligando Flask)...')
                SERVER_PAUSED = True
                if requests is not None:
                    try:
                        requests.post(f'{url}/__shutdown', timeout=1)
                    except Exception as e:
                        print('Erro ao chamar __shutdown:', e)
                # esperar thread morrer
                if server_thread is not None:
                    for _ in range(50):
                        if not server_thread.is_alive():
                            break
                        time.sleep(0.1)
                SERVER_RUNNING = False
            else:
                # ligar servidor
                print('Ligando servidor Flask...')
                SERVER_PAUSED = False
                start_flask_server()

            # atualizar texto do menu: se rodando = "Pausar", se parado = "Ligar"
            try:
                texto = 'Pausar' if SERVER_RUNNING else 'Ligar'
                icon.menu = pystray.Menu(
                    pystray.MenuItem(texto, toggle_pause),
                    pystray.MenuItem('Sair', quit_app)
                )
                icon.update_menu()
            except Exception:
                pass

        # carregar imagem personalizada para o ícone da tray (apenas icon.png)
        icon_path_png = Path(__file__).with_name("icon.png")
        if not icon_path_png.is_file():
            print("Erro: icon.png não encontrado ao lado do executável. Ícone da tray não será exibido.")
            # fallback: rodar como se não houvesse pystray/imagem
            print('pystray/Pillow instalados, mas sem icon.png — rodando sem ícone na tray. Abra:', url)
            try:
                while True:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                try:
                    import requests
                    requests.post(f'{url}/__shutdown', timeout=1)
                except Exception:
                    pass
            return

        try:
            image = Image.open(icon_path_png)
        except Exception as e:
            print(f"Erro ao carregar icon.png: {e}")
            print('Rodando sem ícone na tray. Abra:', url)
            try:
                while True:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                try:
                    import requests
                    requests.post(f'{url}/__shutdown', timeout=1)
                except Exception:
                    pass
            return

        # definir menu inicial (servidor começa ATIVO -> botão mostra "Pausar")
        menu = pystray.Menu(
            pystray.MenuItem('Pausar', toggle_pause),
            pystray.MenuItem('Sair', quit_app)
        )
        icon = pystray.Icon('ez2markdown', image, 'Source BR - HUB Server', menu=menu)

        try:
            icon.run()  # bloqueante até quit_app ou click direito -> sair
        except Exception as e:
            # se der erro na tray, manter o processo rodando enquanto o servidor estiver vivo
            print('Erro no ícone da tray:', e)
            while True:
                time.sleep(0.5)

    start_tray()  # iniciar a tray (bloqueante) no thread principal