# backend/scripts/generar_qr.py
import sys
import json
import qrcode
from PIL import Image, ImageDraw, ImageFont
import os

def generar_qr_con_logo(datos_json, ruta_salida):
    """
    Genera un código QR con los datos proporcionados
    """
    try:
        # Parsear los datos
        datos = json.loads(datos_json)
        
        # Crear código QR
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_H,
            box_size=10,
            border=4,
        )
        
        # Agregar datos al QR (como string JSON)
        qr.add_data(json.dumps(datos, ensure_ascii=False))
        qr.make(fit=True)
        
        # Crear imagen QR
        img_qr = qr.make_image(fill_color="#003366", back_color="white")
        img_qr = img_qr.convert('RGB')
        
        # Crear imagen final con espacio para texto
        ancho, alto = img_qr.size
        img_final = Image.new('RGB', (ancho, alto + 60), 'white')
        img_final.paste(img_qr, (0, 30))
        
        # Agregar texto institucional
        draw = ImageDraw.Draw(img_final)
        
        # Texto del código
        draw.text(
            (ancho//2, alto + 45),
            f"Código: {datos.get('codigo', 'N/A')}",
            fill="#003366",
            anchor="mm"
        )
        
        # Guardar imagen
        img_final.save(ruta_salida)
        print(f"QR guardado en: {ruta_salida}")
        
        return True
        
    except Exception as e:
        print(f"Error generando QR: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Uso: python generar_qr.py <datos_json> <ruta_salida>", file=sys.stderr)
        sys.exit(1)
    
    datos_json = sys.argv[1]
    ruta_salida = sys.argv[2]
    
    if generar_qr_con_logo(datos_json, ruta_salida):
        sys.exit(0)
    else:
        sys.exit(1)