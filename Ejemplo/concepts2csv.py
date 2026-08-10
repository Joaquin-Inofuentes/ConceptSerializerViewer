#!/usr/bin/env python3
"""
concepts2csv.py — Vuelca TODA la data de un archivo .concepts a un CSV bruto.

Uso:
    python concepts2csv.py ruta/al/Dibujo.concepts [carpeta_salida]

Genera:
    <carpeta_salida>/<nombre>.csv            CSV separado por ';', 1 fila = 1 elemento,
                                             1 columna por propiedad (union de todas).
    <carpeta_salida>/binarios/               Cada binario embebido en su formato real:
                                             recursos (PDF/imagenes) tal cual, blobs de
                                             puntos y flags como .bin.
    Las columnas *_base64 llevan el mismo binario en base64 dentro del CSV.

Requiere: pip install msgpack
"""
import sys, os, json, csv, struct, base64, zipfile, hashlib, datetime

try:
    import msgpack
except ImportError:
    sys.exit("Falta msgpack:  pip install msgpack")

EXT_NOMBRES = {0: "vec2", 1: "tamano", 2: "rango", 4: "color_rgba", 5: "uuid", 7: "matriz4x4"}

def ext_hook(code, data):
    return ("EXT", code, data)

def f32s(b):
    return struct.unpack("<%df" % (len(b) // 4), b)

def uuid_str(b):
    h = b.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"

def ts_str(t):
    try:
        return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f UTC")
    except Exception:
        return ""

def rgba_hex(c):
    return "#" + "".join(f"{int(round(max(0,min(1,v))*255)):02X}" for v in c[:3]) + f"{int(round(max(0,min(1,c[3]))*255)):02X}"

def isext(o, c=None):
    ok = isinstance(o, tuple) and len(o) == 3 and o[0] == "EXT"
    return ok and (c is None or o[1] == c)

# ------------------------------------------------------------------ flatten
def aplanar(obj, prefijo, fila):
    """Convierte cualquier estructura msgpack en columnas planas prefijo.ruta = valor."""
    if isext(obj):
        code, data = obj[1], obj[2]
        nombre = EXT_NOMBRES.get(code, f"ext{code}")
        if code == 5:
            fila[f"{prefijo}.{nombre}"] = uuid_str(data)
        elif code in (0, 1, 2):
            v = f32s(data)
            fila[f"{prefijo}.{nombre}_x"] = v[0]
            fila[f"{prefijo}.{nombre}_y"] = v[1]
        elif code == 4:
            v = f32s(data)
            for i, ch in enumerate("rgba"):
                fila[f"{prefijo}.{nombre}_{ch}"] = round(v[i], 6)
            fila[f"{prefijo}.{nombre}_hex"] = rgba_hex(v)
        elif code == 7:
            v = f32s(data)
            for i, val in enumerate(v):
                fila[f"{prefijo}.m{i//4}{i%4}"] = round(val, 6)
        else:
            fila[f"{prefijo}.{nombre}_hex"] = data.hex()
    elif isinstance(obj, bytes):
        try:
            fila[prefijo] = obj.decode("utf-8")
        except UnicodeDecodeError:
            fila[f"{prefijo}.base64"] = base64.b64encode(obj).decode()
            fila[f"{prefijo}.bytes"] = len(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            k = k.decode() if isinstance(k, bytes) else (uuid_str(k[2]) if isext(k, 5) else str(k))
            aplanar(v, f"{prefijo}.{k}", fila)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            aplanar(v, f"{prefijo}[{i}]", fila)
    elif obj is None:
        pass
    else:
        fila[prefijo] = obj

# ------------------------------------------------------------------ parser
def convertir(ruta, outdir=None):
    nombre = os.path.splitext(os.path.basename(ruta))[0]
    outdir = outdir or nombre + "_csv"
    bindir = os.path.join(outdir, "binarios")
    os.makedirs(bindir, exist_ok=True)
    filas = []
    contador = {"n": 0}

    def nueva(tipo, **kw):
        contador["n"] += 1
        f = {"id": contador["n"], "tipo": tipo}
        f.update(kw)
        filas.append(f)
        return f

    z = zipfile.ZipFile(ruta)
    nombres = z.namelist()

    # ---------- 1. metadata.json ----------
    meta = json.loads(z.read("metadata.json"))
    f = nueva("documento", elemento_uuid=meta.get("identifier"),
              archivo=os.path.basename(ruta), tamano_zip_bytes=os.path.getsize(ruta),
              archivos_en_zip=len(nombres))
    for k, v in meta.items():
        f[f"meta.{k}"] = v

    # ---------- 2. workspace.pack ----------
    if "workspace.pack" in nombres:
        ws = msgpack.unpackb(z.read("workspace.pack"), raw=True,
                             strict_map_key=False, ext_hook=ext_hook)
        f = nueva("workspace", esquema_version=ws[0] if isinstance(ws, list) else "")
        for i, elem in enumerate(ws[1:] if isinstance(ws, list) else [], 1):
            # el elemento 1 suele ser un JSON de UI embebido
            if isinstance(elem, (bytes, str)):
                s = elem.decode() if isinstance(elem, bytes) else elem
                try:
                    aplanar(json.loads(s), "ui", f)
                    continue
                except Exception:
                    pass
            aplanar(elem, f"ws[{i}]", f)

    # ---------- 3. resource.pack + recursos ----------
    recursos = {}
    if "resource.pack" in nombres:
        rp = msgpack.unpackb(z.read("resource.pack"), raw=True,
                             strict_map_key=False, ext_hook=ext_hook)
        mapa = rp[1] if isinstance(rp, list) and len(rp) > 1 and isinstance(rp[1], dict) else {}
        for k, v in mapa.items():
            ruuid = uuid_str(k[2]) if isext(k, 5) else str(k)
            arch = next((n for n in nombres if ruuid.replace("-", "") in n.replace("-", "")), None)
            datos = z.read(arch) if arch else b""
            md5_pack = ""
            tipo_codigo = ""
            if isinstance(v, list):
                tipo_codigo = v[1] if len(v) > 1 else ""
                md5b = next((x for x in v if isinstance(x, bytes) and len(x) == 16), None)
                md5_pack = md5b.hex() if md5b else ""
            ext = os.path.splitext(arch or "")[1] or ".bin"
            destino = os.path.join(bindir, f"recurso_{ruuid}{ext}")
            if datos:
                open(destino, "wb").write(datos)
            f = nueva("recurso", elemento_uuid=ruuid,
                      recurso_tipo_codigo=tipo_codigo,
                      recurso_archivo_en_zip=arch or "",
                      recurso_extension=ext,
                      recurso_bytes=len(datos),
                      recurso_md5_declarado=md5_pack,
                      recurso_md5_real=hashlib.md5(datos).hexdigest() if datos else "",
                      recurso_md5_coincide=(hashlib.md5(datos).hexdigest() == md5_pack) if datos and md5_pack else "",
                      recurso_exportado_a=destino,
                      recurso_base64=base64.b64encode(datos).decode() if datos else "")
            aplanar(v, "raw", f)
            recursos[ruuid] = destino

    # ---------- 4. tree.pack: capas / trazos / imagenes ----------
    tree = msgpack.unpackb(z.read("tree.pack"), raw=True,
                           strict_map_key=False, ext_hook=ext_hook)
    nueva("arbol", esquema_version=tree[0] if isinstance(tree, list) else "")

    def procesar_capa(nodo, idx):
        hdr = nodo[1]  # [4, UUID, None, ts, matriz, locked, visible, opacidad]
        f = nueva("capa", capa_indice=idx,
                  elemento_uuid=uuid_str(hdr[1][2]) if isext(hdr[1], 5) else "",
                  timestamp_unix=hdr[3] if len(hdr) > 3 else "",
                  timestamp_utc=ts_str(hdr[3]) if len(hdr) > 3 and isinstance(hdr[3], float) else "")
        aplanar(hdr, "raw", f)
        capa_uuid = f.get("elemento_uuid", "")
        for item in (nodo[2] if len(nodo) > 2 and isinstance(nodo[2], list) else []):
            procesar_item(item, capa_uuid, idx)

    def procesar_item(item, capa_uuid, capa_idx):
        if not isinstance(item, list) or not item:
            return
        tipo = item[0]
        cuerpo = item[1] if len(item) > 1 else None
        if tipo == 8 and isinstance(cuerpo, list):          # ---- IMAGEN / PDF colocado
            interno = cuerpo[1] if len(cuerpo) > 1 and isinstance(cuerpo[1], list) else []
            f = nueva("imagen", capa_uuid=capa_uuid, capa_indice=capa_idx)
            u = next((x for x in interno if isext(x, 5)), None)
            f["elemento_uuid"] = uuid_str(u[2]) if u else ""
            ru = next((x for x in cuerpo if isext(x, 5)), None)
            f["recurso_uuid"] = uuid_str(ru[2]) if ru else ""
            f["recurso_exportado_a"] = recursos.get(f["recurso_uuid"], "")
            tam = next((x for x in cuerpo if isext(x, 1)), None)
            if tam:
                w, h = f32s(tam[2]); f["ancho_puntos"], f["alto_puntos"] = w, h
            mat = next((x for x in interno if isext(x, 7)), None)
            if mat:
                v = f32s(mat[2])
                f["escala_x"], f["escala_y"] = round(v[0], 6), round(v[5], 6)
                f["traslacion_x"], f["traslacion_y"] = round(v[12], 4), round(v[13], 4)
            ts = next((x for x in interno if isinstance(x, float) and x > 1e9), None)
            if ts:
                f["timestamp_unix"], f["timestamp_utc"] = ts, ts_str(ts)
            aplanar(item, "raw", f)
        elif tipo == 1 and len(item) > 1 and isinstance(item[1], list) and item[1] and item[1][0] == 4:
            procesar_capa(item[1:][0] if False else item[1], capa_idx)  # subcapa (raro)
        else:
            # buscar trazos en profundidad
            buscar_trazos(item, capa_uuid, capa_idx)

    def buscar_trazos(o, capa_uuid, capa_idx):
        if not isinstance(o, list):
            return
        blobs = [x for x in o if isinstance(x, bytes) and len(x) >= 32 and len(x) % 16 == 0]
        if blobs and len(o) > 2 and o[0] == 6 and isinstance(o[1], list):
            emitir_trazo(o, blobs[0], capa_uuid, capa_idx)
            return
        for x in o:
            buscar_trazos(x, capa_uuid, capa_idx)

    def emitir_trazo(o, blob, capa_uuid, capa_idx):
        hdr = o[1]
        f = nueva("trazo", capa_uuid=capa_uuid, capa_indice=capa_idx)
        try:
            bw = hdr[1][1]              # [1, [0,[0,id],EXT4,1.0], None, grosor, 0.0]
            core = bw[1]
            f["pincel_id"] = core[1][1]
            col = f32s(core[2][2])
            f["color_r"], f["color_g"], f["color_b"], f["color_a"] = (round(c, 6) for c in col)
            f["color_hex"] = rgba_hex(col)
            f["grosor"] = bw[3]
        except Exception:
            pass
        u = next((x for x in hdr if isext(x, 5)), None)
        f["elemento_uuid"] = uuid_str(u[2]) if u else ""
        ts = next((x for x in hdr if isinstance(x, float) and x > 1e9), None)
        if ts:
            f["timestamp_unix"], f["timestamp_utc"] = ts, ts_str(ts)
        anch = [x for x in o if isinstance(x, list) and x and isinstance(x[0], list)
                and len(x[0]) == 3 and isext(x[0][2], 0)]
        if anch:
            ax, ay = f32s(anch[0][0][2][2])
            f["ancla_x"], f["ancla_y"] = round(ax, 4), round(ay, 4)
        # puntos
        n = len(blob) // 16
        f["num_puntos"] = n
        xs, ys, ps = [], [], []
        for i in range(n):
            x, y = struct.unpack_from("<ff", blob, i * 16)
            pr, t1, t2, pad = struct.unpack_from("<HHHH", blob, i * 16 + 8)
            xs.append(x); ys.append(y); ps.append(pr)
            f[f"pt{i:03d}_x"] = round(x, 4)
            f[f"pt{i:03d}_y"] = round(y, 4)
            f[f"pt{i:03d}_presion"] = pr
            f[f"pt{i:03d}_tilt1"] = t1
            f[f"pt{i:03d}_tilt2"] = t2
            f[f"pt{i:03d}_pad"] = pad
        f["bbox_min_x"], f["bbox_max_x"] = round(min(xs), 4), round(max(xs), 4)
        f["bbox_min_y"], f["bbox_max_y"] = round(min(ys), 4), round(max(ys), 4)
        f["presion_min"], f["presion_max"] = min(ps), max(ps)
        # binarios: blob de puntos y bitmask de flags
        base = f"trazo_{f['elemento_uuid'] or f['id']}"
        destino = os.path.join(bindir, base + "_puntos.bin")
        open(destino, "wb").write(blob)
        f["puntos_bin_exportado_a"] = destino
        f["puntos_base64"] = base64.b64encode(blob).decode()
        flags = [x for x in o if isinstance(x, bytes) and 0 < len(x) < 16]
        if flags:
            fdest = os.path.join(bindir, base + "_flags.bin")
            open(fdest, "wb").write(flags[0])
            f["flags_hex"] = flags[0].hex()
            f["flags_base64"] = base64.b64encode(flags[0]).decode()
            f["flags_bin_exportado_a"] = fdest
        aplanar(hdr, "raw", f)

    # documento raiz: [1027, [0, UUID_doc, 0, config, [capas], ...]]
    doc = tree[1] if isinstance(tree, list) and len(tree) > 1 else tree
    if isinstance(doc, list):
        capas = next((x for x in doc if isinstance(x, list) and x
                      and all(isinstance(c, list) and c and c[0] == 1 for c in x)), [])
        for i, capa in enumerate(capas):
            procesar_capa(capa, i)
        if not capas:                       # fallback: barrer todo el arbol
            buscar_trazos(doc, "", -1)

    # ---------- 5. escribir CSV ----------
    columnas = ["id", "tipo", "elemento_uuid"]
    for f in filas:
        for k in f:
            if k not in columnas:
                columnas.append(k)
    ruta_csv = os.path.join(outdir, nombre + ".csv")
    with open(ruta_csv, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=columnas, delimiter=";", restval="")
        w.writeheader()
        w.writerows(filas)
    print(f"OK: {len(filas)} filas x {len(columnas)} columnas -> {ruta_csv}")
    print(f"Binarios en formato real -> {bindir}/")
    resumen = {}
    for f in filas:
        resumen[f["tipo"]] = resumen.get(f["tipo"], 0) + 1
    print("Elementos:", ", ".join(f"{v} {k}" for k, v in resumen.items()))
    return ruta_csv

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    convertir(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
