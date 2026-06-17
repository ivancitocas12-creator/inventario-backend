const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();

// ============================================
// CONFIGURACIÓN PARA RAILWAY
// ============================================
const DB_HOST     = process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost';
const DB_PORT     = process.env.MYSQLPORT     || process.env.DB_PORT     || 3306;
const DB_USER     = process.env.MYSQLUSER     || process.env.DB_USER     || 'root';
const DB_PASSWORD = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '';
const DB_NAME     = process.env.MYSQLDATABASE || process.env.DB_NAME     || 'railway';

const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${process.env.PORT || 3000}`;

console.log('🔧 Configuración de conexión:');
console.log('Host:', DB_HOST);
console.log('Port:', DB_PORT);
console.log('User:', DB_USER);
console.log('Database:', DB_NAME);
console.log('🌍 URL Pública:', PUBLIC_URL);

// ============================================
// MIDDLEWARES
// ============================================
app.use(cors({
    origin: '*',
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// CARPETAS ESTÁTICAS
// ============================================
const qrDir = path.join(__dirname, 'public/qr');
if (!fs.existsSync(qrDir)) {
    fs.mkdirSync(qrDir, { recursive: true });
    console.log('📁 Carpeta QR creada:', qrDir);
}
app.use('/qr', express.static(qrDir));

// ============================================
// COLORES INSTITUCIONALES PARA EXCEL
// ============================================
const COLORES = {
    AZUL:       '003366',
    DORADO:     'FFD700',
    BLANCO:     'FFFFFF',
    GRIS:       'F5F5F5',
    AZUL_CLARO: '4D7EB3'
};

// ============================================
// CONEXIÓN A MYSQL (POOL)
// ============================================
const pool = mysql.createPool({
    host:             DB_HOST,
    port:             DB_PORT,
    user:             DB_USER,
    password:         DB_PASSWORD,
    database:         DB_NAME,
    waitForConnections: true,
    connectionLimit:  10,
    queueLimit:       0,
    // ✅ Reconexión automática
    enableKeepAlive:  true,
    keepAliveInitialDelay: 0
});

const promisePool = pool.promise();

pool.getConnection((err, connection) => {
    if (err) { console.error('❌ Error conectando a MySQL:', err.message); return; }
    console.log('✅ Conectado a MySQL correctamente');
    connection.release();
});

// ============================================
// CREAR TABLAS SI NO EXISTEN
// ============================================
async function inicializarTablas() {
    try {
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS categorias (
                id     INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(100) NOT NULL,
                descripcion TEXT
            )
        `);
        await promisePool.query(`
            INSERT IGNORE INTO categorias (id, nombre) VALUES
            (1,'Vidriería'),(2,'Reactivos'),(3,'Equipos'),(4,'Seguridad'),(5,'General')
        `);
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS materiales (
                id                  INT AUTO_INCREMENT PRIMARY KEY,
                codigo_unico        VARCHAR(100) NOT NULL UNIQUE,
                nombre              VARCHAR(255) NOT NULL,
                descripcion         TEXT,
                categoria_id        INT DEFAULT 1,
                cantidad_total      INT DEFAULT 0,
                cantidad_disponible INT DEFAULT 0,
                ubicacion           VARCHAR(255) DEFAULT 'Sin ubicación',
                imagen_url          VARCHAR(500),
                qr_code_path        VARCHAR(500),
                fecha_registro      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (categoria_id) REFERENCES categorias(id)
            )
        `);
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id             INT AUTO_INCREMENT PRIMARY KEY,
                nombre_completo VARCHAR(255) NOT NULL,
                email          VARCHAR(255),
                rol            VARCHAR(50) DEFAULT 'alumno',
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await promisePool.query(`
            CREATE TABLE IF NOT EXISTS prestamos (
                id                  INT AUTO_INCREMENT PRIMARY KEY,
                material_id         INT NOT NULL,
                usuario_id          INT NOT NULL,
                cantidad            INT NOT NULL,
                fecha_prestamo      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                fecha_devolucion    DATE NOT NULL,
                fecha_devolucion_real DATE,
                observaciones       TEXT,
                estado              ENUM('activo','devuelto','vencido') DEFAULT 'activo',
                FOREIGN KEY (material_id) REFERENCES materiales(id),
                FOREIGN KEY (usuario_id)  REFERENCES usuarios(id)
            )
        `);
        console.log('✅ Tablas verificadas/creadas correctamente');
    } catch (err) {
        console.error('❌ Error inicializando tablas:', err.message);
    }
}
inicializarTablas();

// ============================================
// FUNCIÓN PARA GENERAR QR CON PYTHON
// ============================================
function generarQRPython(codigo_unico, nombre, callback) {
    const nombreArchivo = `${codigo_unico.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
    const rutaCompleta  = path.join(qrDir, nombreArchivo);
    const urlCompleta   = `${PUBLIC_URL}/qr/${nombreArchivo}`;

    const datosQR = JSON.stringify({
        codigo:   codigo_unico,
        nombre:   nombre,
        tipo:     'material_laboratorio',
        escuela:  'Ofic. No. 0167 Prof. Filiberto Navas Valdés',
        url_api:  `${PUBLIC_URL}/api/materiales/por-codigo/${codigo_unico}`
    });

    const pythonProcess = spawn('python3', [
        path.join(__dirname, 'scripts/generar_qr.py'),
        datosQR,
        rutaCompleta
    ]);

    pythonProcess.on('close', (code) => {
        if (code === 0) {
            console.log(`✅ QR generado: ${nombreArchivo}`);
            callback(null, { archivo: nombreArchivo, ruta: rutaCompleta, url: urlCompleta });
        } else {
            console.error(`❌ Error generando QR, código: ${code}`);
            callback(new Error('Error al generar QR'), null);
        }
    });

    pythonProcess.stderr.on('data', (data) => console.error(`QR stderr: ${data}`));
}

// Wrapper promisificado del generador de QR
function generarQRPromise(codigo_unico, nombre) {
    return new Promise((resolve, reject) => {
        generarQRPython(codigo_unico, nombre, (err, info) => {
            if (err) reject(err);
            else resolve(info);
        });
    });
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', async (req, res) => {
    try {
        await promisePool.query('SELECT 1');
        const [materialCount] = await promisePool.query('SELECT COUNT(*) as count FROM materiales');
        const [prestamoCount] = await promisePool.query('SELECT COUNT(*) as count FROM prestamos WHERE estado = "activo"');
        const [qrCount]       = await promisePool.query('SELECT COUNT(*) as count FROM materiales WHERE qr_code_path IS NOT NULL');
        res.json({
            status: 'OK',
            message: 'Servidor funcionando correctamente',
            timestamp: new Date().toISOString(),
            database: {
                connected: true,
                materiales: materialCount[0].count,
                prestamos_activos: prestamoCount[0].count,
                materiales_con_qr: qrCount[0].count
            },
            sistema: { qr_folder: fs.existsSync(qrDir), version: '4.0.0' }
        });
    } catch (error) {
        res.status(500).json({ status: 'ERROR', message: error.message, timestamp: new Date().toISOString() });
    }
});

// ============================================
// RUTAS DE MATERIALES
// ============================================

// GET todos los materiales
app.get('/api/materiales', async (req, res) => {
    try {
        const { limit = 500, offset = 0, search = '' } = req.query;
        let query = `
            SELECT m.*, c.nombre as categoria_nombre
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
        `;
        const params = [];
        if (search) {
            query += ` WHERE m.nombre LIKE ? OR m.codigo_unico LIKE ? OR m.ubicacion LIKE ?`;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        query += ` ORDER BY m.nombre ASC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [results] = await promisePool.query(query, params);
        const [countResult] = await promisePool.query('SELECT COUNT(*) as total FROM materiales');
        res.json({ data: results, total: countResult[0].total, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (error) {
        console.error('Error GET materiales:', error);
        res.status(500).json({ error: 'Error al obtener materiales' });
    }
});

// GET material por código único (para escanear QR)
app.get('/api/materiales/por-codigo/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const [results] = await promisePool.query(`
            SELECT m.*, c.nombre as categoria_nombre
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            WHERE m.codigo_unico = ?
        `, [codigo]);
        if (results.length === 0) return res.status(404).json({ error: 'Material no encontrado' });
        res.json(results[0]);
    } catch (error) {
        console.error('Error GET por-codigo:', error);
        res.status(500).json({ error: 'Error al obtener el material' });
    }
});

// GET material por ID
app.get('/api/materiales/:id', async (req, res) => {
    try {
        const [results] = await promisePool.query(`
            SELECT m.*, c.nombre as categoria_nombre
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            WHERE m.id = ?
        `, [req.params.id]);
        if (results.length === 0) return res.status(404).json({ error: 'Material no encontrado' });
        res.json(results[0]);
    } catch (error) {
        console.error('Error GET material:', error);
        res.status(500).json({ error: 'Error al obtener el material' });
    }
});

// POST crear un material
app.post('/api/materiales', async (req, res) => {
    try {
        const { codigo_unico, nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion } = req.body;
        if (!codigo_unico || !nombre) return res.status(400).json({ error: 'Faltan campos requeridos: codigo_unico y nombre' });

        const [existente] = await promisePool.query('SELECT id FROM materiales WHERE codigo_unico = ?', [codigo_unico]);
        if (existente.length > 0) return res.status(400).json({ error: 'Ya existe un material con ese código' });

        const total = parseInt(cantidad_total) || 0;
        const disponibleParsed = parseInt(cantidad_disponible);
        const disponible = Number.isFinite(disponibleParsed) ? disponibleParsed : total;

        const [result] = await promisePool.query(`
            INSERT INTO materiales (codigo_unico, nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [codigo_unico, nombre, descripcion || '', categoria_id || 1, total, disponible, ubicacion || 'Sin ubicación']);

        const nuevoId = result.insertId;

        // Generar QR en segundo plano
        generarQRPromise(codigo_unico, nombre)
            .then(qrInfo => promisePool.query('UPDATE materiales SET qr_code_path = ? WHERE id = ?', [qrInfo.url, nuevoId]))
            .catch(e => console.warn('⚠️ QR no generado:', e.message));

        res.status(201).json({ id: nuevoId, message: 'Material creado correctamente', qr_generado: true });
    } catch (error) {
        console.error('Error POST material:', error);
        res.status(500).json({ error: 'Error al crear material' });
    }
});
// ============================================
// IMPORTACIÓN MASIVA DESDE EXCEL (vía JSON)
// ============================================
app.post('/api/materiales/importar', async (req, res) => {
    const { materiales } = req.body;

    if (!Array.isArray(materiales) || materiales.length === 0) {
        return res.status(400).json({ error: 'Se requiere un array de materiales' });
    }

    const insertados = [];
    const errores    = [];
    const omitidos   = [];

    for (let i = 0; i < materiales.length; i++) {
        const m = materiales[i];
        try {
            if (!m.codigo_unico || !m.nombre) {
                errores.push({ fila: i + 1, error: 'Falta código_unico o nombre', dato: m });
                continue;
            }

            // Verificar si ya existe
            const [existente] = await promisePool.query(
                'SELECT id FROM materiales WHERE codigo_unico = ?', [m.codigo_unico]
            );
            if (existente.length > 0) {
                omitidos.push({ fila: i + 1, codigo: m.codigo_unico, razon: 'Ya existe' });
                continue;
            }

            const total = parseInt(m.cantidad_total) || 0;
            const disponibleParsed = parseInt(m.cantidad_disponible);
            const disponible = Number.isFinite(disponibleParsed) ? disponibleParsed : total;

            const [result] = await promisePool.query(`
                INSERT INTO materiales
                    (codigo_unico, nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion, imagen_url, qr_code_path)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                String(m.codigo_unico).trim(),
                String(m.nombre).trim(),
                String(m.descripcion || '').trim(),
                parseInt(m.categoria_id) || 1,
                total,
                disponible,
                String(m.ubicacion || 'Sin ubicación').trim(),
                String(m.imagen_url || '').trim(),
                String(m.qr_code_path || '').trim()
            ]);

            const nuevoId = result.insertId;
            insertados.push({ id: nuevoId, codigo: m.codigo_unico, nombre: m.nombre });

            // Generar QR (si tienes la función)
            if (typeof generarQRPromise === 'function') {
                generarQRPromise(m.codigo_unico, m.nombre)
                    .then(qrInfo => promisePool.query('UPDATE materiales SET qr_code_path = ? WHERE id = ?', [qrInfo.url, nuevoId]))
                    .catch(e => console.warn(`⚠️ QR no generado para ${m.codigo_unico}:`, e.message));
            }

        } catch (err) {
            errores.push({ fila: i + 1, error: err.message, dato: m });
            console.error(`❌ Error en fila ${i + 1}:`, err.message);
        }
    }

    res.status(200).json({
        message: `Importación completada`,
        insertados: insertados.length,
        omitidos:   omitidos.length,
        errores:    errores.length,
        detalle: { insertados, omitidos, errores }
    });
});
// ✅ POST IMPORTACIÓN MASIVA DESDE EXCEL
app.post('/api/materiales/importar', async (req, res) => {
    const { materiales } = req.body;

    if (!Array.isArray(materiales) || materiales.length === 0) {
        return res.status(400).json({ error: 'Se requiere un array de materiales' });
    }

    const insertados = [];
    const errores    = [];
    const omitidos   = [];

    for (let i = 0; i < materiales.length; i++) {
        const m = materiales[i];
        try {
            if (!m.codigo_unico || !m.nombre) {
                errores.push({ fila: i + 1, error: 'Falta código_unico o nombre', dato: m });
                continue;
            }

            // Si ya existe, omitir sin error
            const [existente] = await promisePool.query(
                'SELECT id FROM materiales WHERE codigo_unico = ?', [m.codigo_unico]
            );
            if (existente.length > 0) {
                omitidos.push({ fila: i + 1, codigo: m.codigo_unico, razon: 'Ya existe' });
                continue;
            }

            const total = parseInt(m.cantidad_total) || 0;
            const disponibleParsed = parseInt(m.cantidad_disponible);
            const disponible = Number.isFinite(disponibleParsed) ? disponibleParsed : total;

            const [result] = await promisePool.query(`
                INSERT INTO materiales
                    (codigo_unico, nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion, imagen_url, qr_code_path)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                String(m.codigo_unico).trim(),
                String(m.nombre).trim(),
                String(m.descripcion || '').trim(),
                parseInt(m.categoria_id) || 1,
                total,
                disponible,
                String(m.ubicacion || 'Sin ubicación').trim(),
                String(m.imagen_url || '').trim(),
                String(m.qr_code_path || '').trim()
            ]);

            const nuevoId = result.insertId;
            insertados.push({ id: nuevoId, codigo: m.codigo_unico, nombre: m.nombre });

            // Generar QR en segundo plano (no bloquea el loop)
            generarQRPromise(m.codigo_unico, m.nombre)
                .then(qrInfo => promisePool.query('UPDATE materiales SET qr_code_path = ? WHERE id = ?', [qrInfo.url, nuevoId]))
                .catch(e => console.warn(`⚠️ QR no generado para ${m.codigo_unico}:`, e.message));

        } catch (err) {
            errores.push({ fila: i + 1, error: err.message, dato: m });
            console.error(`❌ Error en fila ${i + 1}:`, err.message);
        }
    }

    res.status(200).json({
        message: `Importación completada`,
        insertados: insertados.length,
        omitidos:   omitidos.length,
        errores:    errores.length,
        detalle: { insertados, omitidos, errores }
    });
});

// PUT actualizar material
app.put('/api/materiales/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion } = req.body;

        if (cantidad_disponible > cantidad_total) {
            return res.status(400).json({ error: 'La cantidad disponible no puede ser mayor que la total' });
        }

        const [result] = await promisePool.query(`
            UPDATE materiales
            SET nombre=?, descripcion=?, categoria_id=?, cantidad_total=?, cantidad_disponible=?, ubicacion=?
            WHERE id=?
        `, [nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion, id]);

        if (result.affectedRows === 0) return res.status(404).json({ error: 'Material no encontrado' });
        res.json({ message: 'Material actualizado correctamente' });
    } catch (error) {
        console.error('Error PUT material:', error);
        res.status(500).json({ error: 'Error al actualizar material' });
    }
});

// DELETE eliminar material
app.delete('/api/materiales/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [prestamos] = await promisePool.query(
            'SELECT id FROM prestamos WHERE material_id = ? AND estado = "activo"', [id]
        );
        if (prestamos.length > 0) return res.status(400).json({ error: 'Tiene préstamos activos, no se puede eliminar' });

        const [material] = await promisePool.query('SELECT qr_code_path FROM materiales WHERE id = ?', [id]);
        const [result]   = await promisePool.query('DELETE FROM materiales WHERE id = ?', [id]);

        if (result.affectedRows === 0) return res.status(404).json({ error: 'Material no encontrado' });

        // Borrar archivo QR si existe
        if (material.length > 0 && material[0].qr_code_path) {
            const nombreArchivo = material[0].qr_code_path.split('/').pop();
            const rutaQR = path.join(qrDir, nombreArchivo);
            if (fs.existsSync(rutaQR)) fs.unlinkSync(rutaQR);
        }

        res.json({ message: 'Material eliminado correctamente' });
    } catch (error) {
        console.error('Error DELETE material:', error);
        res.status(500).json({ error: 'Error al eliminar material' });
    }
});

// POST regenerar QR
app.post('/api/materiales/:id/regenerar-qr', async (req, res) => {
    try {
        const { id } = req.params;
        const [material] = await promisePool.query(
            'SELECT codigo_unico, nombre, qr_code_path FROM materiales WHERE id = ?', [id]
        );
        if (material.length === 0) return res.status(404).json({ error: 'Material no encontrado' });

        const { codigo_unico, nombre, qr_code_path } = material[0];

        if (qr_code_path) {
            const rutaQR = path.join(qrDir, qr_code_path.split('/').pop());
            if (fs.existsSync(rutaQR)) fs.unlinkSync(rutaQR);
        }

        const qrInfo = await generarQRPromise(codigo_unico, nombre);
        await promisePool.query('UPDATE materiales SET qr_code_path = ? WHERE id = ?', [qrInfo.url, id]);
        res.json({ message: 'QR regenerado correctamente', qr_url: qrInfo.url });
    } catch (error) {
        console.error('Error regenerar QR:', error);
        res.status(500).json({ error: 'Error al regenerar QR' });
    }
});

// ============================================
// BUSCAR QR (escaneo desde cámara)
// ============================================
app.get('/api/qr/buscar/:codigo', async (req, res) => {
    try {
        const codigo = decodeURIComponent(req.params.codigo);

        // Intentar parsear si viene como JSON del QR
        let codigoBusqueda = codigo;
        try {
            const parsed = JSON.parse(codigo);
            codigoBusqueda = parsed.codigo || parsed.url_api?.split('/').pop() || codigo;
        } catch (_) { /* no es JSON, usar directo */ }

        const [results] = await promisePool.query(`
            SELECT m.*, c.nombre as categoria_nombre
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            WHERE m.codigo_unico = ? OR m.codigo_unico LIKE ?
        `, [codigoBusqueda, `%${codigoBusqueda}%`]);

        if (results.length === 0) return res.status(404).json({ error: 'Material no encontrado con ese QR' });
        res.json({ found: true, material: results[0] });
    } catch (error) {
        console.error('Error buscar QR:', error);
        res.status(500).json({ error: 'Error al buscar por QR' });
    }
});

// ============================================
// EXPORTAR A EXCEL
// ============================================
app.get('/api/exportar-excel', async (req, res) => {
    try {
        const [materiales] = await promisePool.query(`
            SELECT m.id, m.codigo_unico, m.nombre, m.descripcion,
                   c.nombre as categoria,
                   m.cantidad_total, m.cantidad_disponible,
                   (m.cantidad_total - m.cantidad_disponible) as cantidad_prestada,
                   m.ubicacion, m.qr_code_path,
                   DATE_FORMAT(m.fecha_registro, '%d/%m/%Y') as fecha_registro,
                   CASE
                       WHEN m.cantidad_disponible = 0 THEN 'AGOTADO'
                       WHEN m.cantidad_disponible < (m.cantidad_total * 0.2) THEN 'CRÍTICO'
                       WHEN m.cantidad_disponible < (m.cantidad_total * 0.5) THEN 'BAJO'
                       ELSE 'NORMAL'
                   END as estado
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            ORDER BY m.nombre ASC
        `);

        const [stats] = await promisePool.query(`
            SELECT COUNT(*) as total_materiales, SUM(cantidad_total) as total_items,
                   SUM(cantidad_disponible) as items_disponibles,
                   SUM(cantidad_total - cantidad_disponible) as items_prestados,
                   COUNT(CASE WHEN cantidad_disponible = 0 THEN 1 END) as materiales_agotados,
                   COUNT(CASE WHEN cantidad_disponible < cantidad_total * 0.2 THEN 1 END) as materiales_criticos
            FROM materiales
        `);

        const workbook  = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Inventario');

        // Título
        worksheet.mergeCells('A1:L3');
        const titleCell = worksheet.getCell('A1');
        titleCell.value = 'ESCUELA SECUNDARIA OFIC. No. 0167 "PROFR. FILIBERTO NAVAS VALDÉS"\nINVENTARIO DE LABORATORIO QUÍMICO';
        titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        titleCell.font = { bold: true, size: 14, color: { argb: COLORES.AZUL } };
        titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.DORADO } };

        // Fecha
        worksheet.mergeCells('A4:L4');
        const dateCell = worksheet.getCell('A4');
        dateCell.value = `Exportado: ${new Date().toLocaleString('es-MX')}`;
        dateCell.font  = { italic: true, color: { argb: '666666' } };
        dateCell.alignment = { horizontal: 'right' };

        // Encabezados
        const headers = ['ID','Código','Nombre','Descripción','Categoría','Total','Disponible','Prestado','Ubicación','QR','Fecha Reg.','Estado'];
        const headerRow = worksheet.addRow(headers);
        headerRow.height = 25;
        headerRow.eachCell(cell => {
            cell.font      = { bold: true, color: { argb: COLORES.BLANCO }, size: 11 };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.AZUL } };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border    = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
        });

        // Datos
        materiales.forEach((item, index) => {
            const row = worksheet.addRow([
                item.id, item.codigo_unico, item.nombre, item.descripcion, item.categoria,
                item.cantidad_total, item.cantidad_disponible, item.cantidad_prestada,
                item.ubicacion, item.qr_code_path ? 'SÍ' : 'NO', item.fecha_registro, item.estado
            ]);
            if (index % 2 === 0) {
                row.eachCell(cell => { cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: COLORES.GRIS } }; });
            }
            const estadoCell = row.getCell(12);
            if      (item.estado === 'AGOTADO')  { estadoCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF6B6B' } }; estadoCell.font = { bold:true, color:{ argb:COLORES.BLANCO } }; }
            else if (item.estado === 'CRÍTICO')  { estadoCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFA500' } }; }
            else if (item.estado === 'BAJO')     { estadoCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE55C' } }; }
            row.eachCell(cell => { cell.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} }; });
        });

        // Hoja estadísticas
        const statsSheet = workbook.addWorksheet('Estadísticas');
        statsSheet.mergeCells('A1:B2');
        const st = statsSheet.getCell('A1');
        st.value = 'RESUMEN ESTADÍSTICO';
        st.font  = { bold:true, size:14, color:{ argb: COLORES.AZUL } };
        st.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb: COLORES.DORADO } };
        st.alignment = { horizontal:'center', vertical:'middle' };

        const statsData = [
            ['Total materiales', stats[0].total_materiales],
            ['Total items',      stats[0].total_items],
            ['Disponibles',      stats[0].items_disponibles],
            ['Prestados',        stats[0].items_prestados],
            ['Agotados',         stats[0].materiales_agotados],
            ['Estado crítico',   stats[0].materiales_criticos],
            ['% Disponibilidad', stats[0].total_items > 0 ? ((stats[0].items_disponibles / stats[0].total_items) * 100).toFixed(2) + '%' : '0%']
        ];
        let r = 4;
        statsData.forEach(([label, value]) => {
            statsSheet.getCell(`A${r}`).value = label;
            statsSheet.getCell(`A${r}`).font  = { bold: true };
            statsSheet.getCell(`B${r}`).value = value;
            r++;
        });

        // Anchos de columna
        [8, 16, 30, 25, 15, 8, 10, 10, 20, 6, 12, 10].forEach((w, i) => {
            worksheet.columns[i] && (worksheet.columns[i].width = w);
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=inventario_${new Date().toISOString().split('T')[0]}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error exportar Excel:', error);
        res.status(500).json({ error: 'Error al exportar inventario' });
    }
});

// ============================================
// CATEGORÍAS
// ============================================
app.get('/api/categorias', async (req, res) => {
    try {
        const [results] = await promisePool.query(`
            SELECT c.*, COUNT(m.id) as total_materiales
            FROM categorias c
            LEFT JOIN materiales m ON c.id = m.categoria_id
            GROUP BY c.id ORDER BY c.nombre ASC
        `);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener categorías' });
    }
});

app.get('/api/categorias/:id', async (req, res) => {
    try {
        const [results] = await promisePool.query('SELECT * FROM categorias WHERE id = ?', [req.params.id]);
        if (results.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' });
        res.json(results[0]);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener categoría' });
    }
});

// ============================================
// PRÉSTAMOS
// ============================================
app.get('/api/prestamos/activos', async (req, res) => {
    try {
        const [results] = await promisePool.query(`
            SELECT p.*, m.nombre as material_nombre, m.codigo_unico,
                   u.nombre_completo as usuario_nombre,
                   DATEDIFF(p.fecha_devolucion, CURDATE()) as dias_restantes
            FROM prestamos p
            JOIN materiales m ON p.material_id = m.id
            JOIN usuarios   u ON p.usuario_id  = u.id
            WHERE p.estado = 'activo'
            ORDER BY p.fecha_devolucion ASC
        `);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener préstamos' });
    }
});

app.get('/api/prestamos/historial', async (req, res) => {
    try {
        const [results] = await promisePool.query(`
            SELECT p.*, m.nombre as material_nombre, u.nombre_completo as usuario_nombre
            FROM prestamos p
            JOIN materiales m ON p.material_id = m.id
            JOIN usuarios   u ON p.usuario_id  = u.id
            ORDER BY p.fecha_prestamo DESC
            LIMIT 100
        `);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

app.post('/api/prestamos', async (req, res) => {
    const connection = await promisePool.getConnection();
    try {
        await connection.beginTransaction();
        const { material_id, usuario_id, cantidad, fecha_devolucion, observaciones } = req.body;
        const [material] = await connection.query('SELECT cantidad_disponible FROM materiales WHERE id = ? FOR UPDATE', [material_id]);
        if (material.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Material no encontrado' }); }
        if (material[0].cantidad_disponible < cantidad) { await connection.rollback(); return res.status(400).json({ error: 'Stock insuficiente', disponible: material[0].cantidad_disponible }); }
        const [prestamoResult] = await connection.query(
            'INSERT INTO prestamos (material_id, usuario_id, cantidad, fecha_devolucion, observaciones, estado) VALUES (?, ?, ?, ?, ?, "activo")',
            [material_id, usuario_id, cantidad, fecha_devolucion, observaciones]
        );
        await connection.query('UPDATE materiales SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?', [cantidad, material_id]);
        await connection.commit();
        res.status(201).json({ id: prestamoResult.insertId, message: 'Préstamo registrado correctamente' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Error al crear préstamo' });
    } finally {
        connection.release();
    }
});

app.put('/api/prestamos/devolver/:id', async (req, res) => {
    const connection = await promisePool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        const [prestamo] = await connection.query('SELECT * FROM prestamos WHERE id = ? AND estado = "activo" FOR UPDATE', [id]);
        if (prestamo.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Préstamo no encontrado o ya devuelto' }); }
        const retraso = new Date() > new Date(prestamo[0].fecha_devolucion);
        await connection.query(
            'UPDATE prestamos SET estado="devuelto", fecha_devolucion_real=CURDATE(), observaciones=CONCAT(IFNULL(observaciones,""),?) WHERE id=?',
            [retraso ? ' - DEVUELTO CON RETRASO' : ' - DEVUELTO A TIEMPO', id]
        );
        await connection.query('UPDATE materiales SET cantidad_disponible = cantidad_disponible + ? WHERE id = ?', [prestamo[0].cantidad, prestamo[0].material_id]);
        await connection.commit();
        res.json({ message: retraso ? 'Devolución registrada con retraso' : 'Devolución registrada correctamente' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Error al devolver préstamo' });
    } finally {
        connection.release();
    }
});

// ============================================
// ESTADÍSTICAS
// ============================================
app.get('/api/estadisticas', async (req, res) => {
    try {
        const [materiales] = await promisePool.query(`
            SELECT COUNT(*) as total_materiales, SUM(cantidad_total) as total_items,
                   SUM(cantidad_disponible) as items_disponibles,
                   COUNT(CASE WHEN cantidad_disponible = 0 THEN 1 END) as materiales_agotados
            FROM materiales
        `);
        const [prestamos] = await promisePool.query(`
            SELECT COUNT(*) as prestamos_activos,
                   COUNT(CASE WHEN fecha_devolucion < CURDATE() THEN 1 END) as prestamos_vencidos
            FROM prestamos WHERE estado = 'activo'
        `);
        const [categorias] = await promisePool.query(`
            SELECT c.nombre, COUNT(m.id) as total
            FROM categorias c LEFT JOIN materiales m ON c.id = m.categoria_id
            GROUP BY c.id
        `);
        res.json({ materiales: materiales[0], prestamos: prestamos[0], categorias });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// ============================================
// RUTA NO ENCONTRADA (404) — SIEMPRE JSON
// ============================================
// Si el frontend llama a un endpoint que no existe (por ejemplo, por un
// desfase de versiones entre backend y frontend, o una ruta mal escrita),
// Express respondería por defecto con una página HTML. Eso es justo lo que
// rompe el "response.json()" del cliente con el error:
// "Unexpected token '<' ... is not valid JSON".
// Este middleware garantiza que SIEMPRE se devuelva JSON.
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado', ruta: req.originalUrl, metodo: req.method });
});

// ============================================
// MANEJO DE ERRORES GLOBAL
// ============================================
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(err.status || err.statusCode || 500).json({ error: 'Error interno del servidor', message: err.message });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log('✅ SERVIDOR INICIADO - VERSIÓN 4.0.0');
    console.log('='.repeat(60));
    console.log(`📍 URL:  ${PUBLIC_URL}`);
    console.log(`📊 API:  ${PUBLIC_URL}/api`);
    console.log(`📁 QR:   ${qrDir}`);
    console.log('\n📋 ENDPOINTS:');
    console.log('   GET    /api/health');
    console.log('   GET    /api/materiales');
    console.log('   POST   /api/materiales          ← 1 material');
    console.log('   POST   /api/materiales/importar ← MASIVO ✅');
    console.log('   PUT    /api/materiales/:id');
    console.log('   DELETE /api/materiales/:id');
    console.log('   GET    /api/materiales/por-codigo/:codigo');
    console.log('   GET    /api/qr/buscar/:codigo   ← BUSCAR QR ✅');
    console.log('   GET    /api/exportar-excel');
    console.log('   GET    /api/categorias');
    console.log('   GET    /api/prestamos/activos');
    console.log('   GET    /api/prestamos/historial');
    console.log('   POST   /api/prestamos');
    console.log('   PUT    /api/prestamos/devolver/:id');
    console.log('   GET    /api/estadisticas');
    console.log('='.repeat(60) + '\n');
});
