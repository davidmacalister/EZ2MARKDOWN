"""
Servidor local de exemplo para receber pedidos de gravação do EZ2.
Instale dependências: pip install flask
Execute:
    python local_server.py --host 127.0.0.1 --port 53423 --base "C:\\Users\\Você\\Documents\\minhaPasta"
Observação: este é um servidor de demonstração. Use com cuidado (não expôr na internet).
"""
from flask import Flask, request, jsonify, send_from_directory, send_file
import argparse, os, json
from pathlib import Path

app = Flask(__name__)
BASE_FOLDER = None

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

@app.after_request
def add_cors(response):
    # permitir chamadas cross-origin (GitHub Pages -> localhost)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

@app.route('/ping', methods=['GET', 'OPTIONS'])
def ping():
    if request.method == 'OPTIONS': return ('', 204)
    return jsonify({"ok": True, "msg": "pong"})

@app.route('/info', methods=['GET', 'OPTIONS'])
def info():
    if request.method == 'OPTIONS': return ('', 204)
    return jsonify({"ok": True, "base": BASE_FOLDER})

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
    return jsonify({"ok": True, "base": BASE_FOLDER})

@app.route('/save', methods=['POST', 'OPTIONS'])
def save():
    if request.method == 'OPTIONS': return ('', 204)
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
        # retorno simplificado: só a base (sem listar arquivos)
        return jsonify({"ok": True, "base": BASE_FOLDER})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/list', methods=['GET', 'OPTIONS'])
def list_route():
    if request.method == 'OPTIONS': return ('', 204)
    if not BASE_FOLDER:
        return jsonify({"ok": False, "error": "base não configurada"}), 400
    files = list_all_files(BASE_FOLDER)
    return jsonify({"ok": True, "base": BASE_FOLDER, "files": files})

@app.route('/file', methods=['GET', 'OPTIONS'])
def serve_file():
    if request.method == 'OPTIONS': return ('', 204)
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

if __name__ == '__main__':
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
    print(f'Servidor local iniciado em {proto}://{args.host}:{args.port} (base={BASE_FOLDER})')
    if not use_tls:
        print('Observação: se o navegador tentar conectar via HTTPS nesta porta (ex.: https://127.0.0.1:53423) e o servidor estiver em HTTP, você verá mensagens como "Bad request version" no log.')
        print('Se desejar evitar isso, execute o servidor com suporte TLS passando --tls-cert <cert.pem> --tls-key <key.pem>.')

    # iniciar Flask; se ssl_context for None, roda em HTTP
    app.run(host=args.host, port=args.port, debug=False, ssl_context=ssl_context)

