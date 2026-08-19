"""Extrae de un .concepts las entradas que necesita el verificador.

Existe porque JSZip, que es lo que usa el lado node del arnes, no puede con
todos los archivos reales: se cae con el dibujo de 262 MB, y tampoco lee los
que quedaron TRUNCADOS por una sincronizacion de Concepts interrumpida (en el
corpus hay dos, sin directorio central ni registro de fin). El visor si los
lee: `zip.ts` reconstruye el indice recorriendo los encabezados locales. Este
script hace lo mismo, para que el arnes no tenga un punto ciego justo en los
archivos mas dificiles.

  python scripts/leer_concepts.py <archivo.concepts>

Escribe en stdout un JSON: { "tree": <base64 de tree.pack>,
                             "exif": { "<entrada>": <orientacion 1..8 o 0> } }
"""
import base64
import json
import struct
import sys
import zipfile
import zlib

SIG_LOCAL = b"PK\x03\x04"
SIG_DATA_DESC = b"PK\x07\x08"


def orientacion_exif(b: bytes) -> int:
    """Orientacion EXIF de un JPEG (1..8), 0 si no trae."""
    if len(b) < 4 or b[0] != 0xFF or b[1] != 0xD8:
        return 0
    i = 2
    while i + 4 < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        marcador = b[i + 1]
        largo = (b[i + 2] << 8) | b[i + 3]
        if marcador == 0xE1:
            t = i + 4
            if b[t:t + 4] == b"Exif":
                tiff = t + 6
                le = b[tiff:tiff + 1] == b"I"
                orden = "<" if le else ">"
                try:
                    off, = struct.unpack_from(orden + "I", b, tiff + 4)
                    ifd = tiff + off
                    n, = struct.unpack_from(orden + "H", b, ifd)
                    for k in range(n):
                        e = ifd + 2 + k * 12
                        tag, = struct.unpack_from(orden + "H", b, e)
                        if tag == 0x0112:
                            val, = struct.unpack_from(orden + "H", b, e + 8)
                            return val
                except struct.error:
                    return 0
            return 0
        # A partir del primer marcador de trama ya no hay metadatos.
        if 0xC0 <= marcador <= 0xCF and marcador != 0xC4:
            return 0
        i += 2 + largo
    return 0


def entradas_escaneando(datos: bytes):
    """Reconstruye el indice recorriendo los encabezados LOCALES.

    Mismo criterio que `readIndexEscaneando` en src/VisorConcept/zip.ts. Con
    "data descriptor" (bit 3 de los flags) los tamaños del encabezado vienen en
    cero y los reales van despues de los datos; se busca la firma del descriptor
    exigiendo que el tamaño que declara coincida con la distancia recorrida, asi
    no corta en una coincidencia casual dentro del stream comprimido.
    """
    salida = {}
    p = 0
    n = len(datos)
    while p + 30 <= n:
        if datos[p:p + 4] != SIG_LOCAL:
            break
        flags, metodo = struct.unpack_from("<HH", datos, p + 6)
        comprimido, = struct.unpack_from("<I", datos, p + 18)
        largo_nombre, largo_extra = struct.unpack_from("<HH", datos, p + 26)
        nombre = datos[p + 30:p + 30 + largo_nombre].decode("utf-8", "replace")
        inicio = p + 30 + largo_nombre + largo_extra

        if comprimido == 0 and (flags & 0x08):
            q = inicio
            hallado = -1
            while True:
                q = datos.find(SIG_DATA_DESC, q)
                if q < 0 or q + 16 > n:
                    break
                declarado, = struct.unpack_from("<I", datos, q + 8)
                if declarado == q - inicio:
                    hallado = q
                    break
                q += 1
            if hallado < 0:
                break
            comprimido = hallado - inicio
            p = hallado + 16
        else:
            p = inicio + comprimido

        if inicio + comprimido > n:
            break
        salida[nombre] = (inicio, comprimido, metodo)
    return salida


def leer_por_directorio(datos: bytes, zf: zipfile.ZipFile):
    """Lee cada entrada ubicando su encabezado local CERCA del offset declarado.

    El dibujo de 262 MB del corpus tiene el directorio central completo pero con
    los offsets corridos unos bytes, asi que `ZipFile.read` se cae con "bad
    magic number". `zip.ts` resuelve lo mismo leyendo con un margen alrededor
    del offset; aca se busca la firma del encabezado en una ventana y se valida
    contra el nombre, para no engancharse con una coincidencia casual.
    """
    def leer_entrada(nombre, _zf=zf, _d=datos):
        info = _zf.getinfo(nombre)
        crudo_nombre = nombre.encode("utf-8")
        base = info.header_offset
        encontrado = -1
        if _d[base:base + 4] == SIG_LOCAL:
            encontrado = base
        else:
            desde = max(0, base - 512)
            ventana = _d[desde:base + 512]
            pos = 0
            while True:
                pos = ventana.find(SIG_LOCAL, pos)
                if pos < 0:
                    break
                abs_pos = desde + pos
                largo_nombre, = struct.unpack_from("<H", _d, abs_pos + 26)
                if _d[abs_pos + 30:abs_pos + 30 + largo_nombre] == crudo_nombre:
                    encontrado = abs_pos
                    break
                pos += 1
        if encontrado < 0:
            raise zipfile.BadZipFile("no se hallo el encabezado local de " + nombre)
        largo_nombre, largo_extra = struct.unpack_from("<HH", _d, encontrado + 26)
        inicio = encontrado + 30 + largo_nombre + largo_extra
        crudo = _d[inicio:inicio + info.compress_size]
        if info.compress_type == zipfile.ZIP_STORED:
            return crudo
        return zlib.decompress(crudo, -15)

    return zf.namelist(), leer_entrada


def leer(ruta: str):
    with open(ruta, "rb") as fh:
        datos = fh.read()

    def por_escaneo():
        idx = entradas_escaneando(datos)
        if not idx:
            raise zipfile.BadZipFile("no se encontro ninguna entrada")

        def leer_entrada(nombre, _idx=idx):
            inicio, comprimido, metodo = _idx[nombre]
            crudo = datos[inicio:inicio + comprimido]
            if metodo == 0:
                return crudo
            return zlib.decompress(crudo, -15)

        return list(idx), leer_entrada

    # Camino normal: el directorio central. Se cae al escaneo ante CUALQUIER
    # fallo, no solo al abrir: en el corpus hay un dibujo de 262 MB cuyo
    # directorio abre bien pero apunta a offsets corridos, asi que el error
    # recien salta al leer una entrada. El escaneo no depende de esos offsets
    # porque busca los encabezados reales.
    try:
        zf = zipfile.ZipFile(ruta)
        nombres, leer_entrada = leer_por_directorio(datos, zf)
        nombre_tree = next((n for n in nombres if n.rsplit("/", 1)[-1] == "tree.pack"), None)
        if nombre_tree is not None:
            leer_entrada(nombre_tree)
    except (zipfile.BadZipFile, zlib.error):
        # Sin directorio central utilizable: archivo truncado (sincronizacion
        # de Concepts interrumpida). Se rescata lo que alcanzo a escribirse.
        nombres, leer_entrada = por_escaneo()

    tree_b64 = None
    for nombre in nombres:
        if nombre.rsplit("/", 1)[-1] == "tree.pack":
            tree_b64 = base64.b64encode(leer_entrada(nombre)).decode("ascii")
            break

    exif = {}
    for nombre in nombres:
        if nombre.lower().endswith((".jpg", ".jpeg")):
            try:
                exif[nombre] = orientacion_exif(leer_entrada(nombre))
            except Exception:
                # Una entrada rota no invalida el resto del archivo.
                exif[nombre] = 0

    return {"tree": tree_b64, "exif": exif, "entradas": nombres}


if __name__ == "__main__":
    json.dump(leer(sys.argv[1]), sys.stdout)
