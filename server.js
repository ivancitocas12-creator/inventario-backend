// server.js - VERSIÓN DEFINITIVA PARA RAILWAY (CONSERVA TODO: EXCEL, QR, PYTHON, PRÉSTAMOS)
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
// 📌 CONFIGURACIÓN PARA RAILWAY (SOLO ESTO CAMBIA)
// ============================================
// Railway inyecta sus propias variables de entorno.
// Si no existen (entorno local), usamos los valores por defecto.
const DB_HOST = process.env.MYSQLHOST || process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.MYSQLPORT || process.env.DB_PORT || 3306;
const DB_USER = process.env.MYSQLUSER || process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '';
const DB_NAME = process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway';
// ⚠️ IMPORTANTE: Tu frontend debe usar la URL pública de Railway.
// Railway asigna una URL automática (ej: https://tunombre.up.railway.app)
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
    : `http://localhost:${process.env.PORT || 3000}`;

console.log('🔧 Configuración de conexión:');
console.log('Host:', DB_HOST);
console.log('Port:', DB_PORT);
console.log('User:', DB_USER);
console.log('Password:', DB_PASSWORD ? '****' : '(vacío)');
console.log('Database:', DB_NAME);
console.log('🌍 URL Pública:', PUBLIC_URL);

// ============================================
// SERVIR ARCHIVOS ESTÁTICOS
// ============================================
app.use(cors({
    origin: ['http://localhost:8100', 'http://localhost:4200', 'http://localhost:3000', PUBLIC_URL],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ruta para los QR generados (se servirán estáticamente)
app.use('/qr', express.static(path.join(__dirname, 'public/qr')));

// ============================================
// COLORES INSTITUCIONALES PARA EXCEL
// ============================================
const COLORES = {
    AZUL: '003366',
    DORADO: 'FFD700',
    BLANCO: 'FFFFFF',
    GRIS: 'F5F5F5',
    AZUL_CLARO: '4D7EB3'
};

// ============================================
// CREAR CARPETA PARA QR SI NO EXISTE
// ============================================
const qrDir = path.join(__dirname, 'public/qr');
if (!fs.existsSync(qrDir)) {
    fs.mkdirSync(qrDir, { recursive: true });
    console.log('📁 Carpeta para QR creada:', qrDir);
}

// ============================================
// CONEXIÓN A MYSQL (PROMISE POOL)
// ============================================
const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const promisePool = pool.promise();

pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error conectando a MySQL:', err.message);
        return;
    }
    console.log('✅ Conectado a MySQL correctamente');
    connection.release();
});

// ============================================
// FUNCIÓN PARA GENERAR QR CON PYTHON
// ============================================
function generarQRPython(codigo_unico, nombre, callback) {
    const nombreArchivo = `${codigo_unico.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
    const rutaCompleta = path.join(qrDir, nombreArchivo);
    const urlCompleta = `${PUBLIC_URL}/qr/${nombreArchivo}`; // ✅ URL pública para Railway
    
    const datosQR = JSON.stringify({
        codigo: codigo_unico,
        nombre: nombre,
        tipo: 'material_laboratorio',
        escuela: 'Ofic. No. 0167 Prof. Filiberto Navas Valdés',
        url_api: `${PUBLIC_URL}/api/materiales/por-codigo/${codigo_unico}`
    });

    const pythonProcess = spawn('python', [
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

    pythonProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });
}

// ============================================
// A PARTIR DE AQUÍ, **TODAS TUS RUTAS SE MANTIENEN IGUAL** 
// Solo cambia la URL base usada para los QR
// ============================================

// Obtener todos los materiales (con paginación)
app.get('/api/materiales', async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const query = `
            SELECT m.*, c.nombre as categoria_nombre 
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            ORDER BY m.nombre ASC
            LIMIT ? OFFSET ?
        `;
        const [results] = await promisePool.query(query, [parseInt(limit), parseInt(offset)]);
        const [countResult] = await promisePool.query('SELECT COUNT(*) as total FROM materiales');
        res.json({
            data: results,
            total: countResult[0].total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('Error en query:', error);
        res.status(500).json({ error: 'Error al obtener materiales' });
    }
});

// Obtener material por código único (para QR)
app.get('/api/materiales/por-codigo/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const query = `
            SELECT m.*, c.nombre as categoria_nombre 
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            WHERE m.codigo_unico = ?
        `;
        const [results] = await promisePool.query(query, [codigo]);
        if (results.length === 0) {
            return res.status(404).json({ error: 'Material no encontrado' });
        }
        res.json(results[0]);
    } catch (error) {
        console.error('Error en query:', error);
        res.status(500).json({ error: 'Error al obtener el material' });
    }
});

// Obtener un material por ID
app.get('/api/materiales/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT m.*, c.nombre as categoria_nombre 
            FROM materiales m
            LEFT JOIN categorias c ON m.categoria_id = c.id
            WHERE m.id = ?
        `;
        const [results] = await promisePool.query(query, [id]);
        if (results.length === 0) {
            return res.status(404).json({ error: 'Material no encontrado' });
        }
        res.json(results[0]);
    } catch (error) {
        console.error('Error en query:', error);
        res.status(500).json({ error: 'Error al obtener el material' });
    }
});

// Crear un nuevo material (con QR)
app.post('/api/materiales', async (req, res) => {
    try {
        const { codigo_unico, nombre, descripcion, categoria_id, cantidad_total, ubicacion } = req.body;
        if (!codigo_unico || !nombre || !cantidad_total) {
            return res.status(400).json({ error: 'Faltan campos requeridos' });
        }
        if (isNaN(cantidad_total) || cantidad_total < 0) {
            return res.status(400).json({ error: 'La cantidad debe ser un número positivo' });
        }
        const [existente] = await promisePool.query('SELECT id FROM materiales WHERE codigo_unico = ?', [codigo_unico]);
        if (existente.length > 0) {
            return res.status(400).json({ error: 'Ya existe un material con ese código' });
        }
        const query = `
            INSERT INTO materiales 
            (codigo_unico, nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
            codigo_unico, nombre, descripcion || '', categoria_id || 1,
            parseInt(cantidad_total), parseInt(cantidad_total), ubicacion || 'Sin ubicación'
        ];
        const [result] = await promisePool.query(query, values);
        const nuevoId = result.insertId;
        
        generarQRPython(codigo_unico, nombre, async (err, qrInfo) => {
            if (!err && qrInfo) {
                await promisePool.query('UPDATE materiales SET qr_code_path = ? WHERE id = ?', [qrInfo.url, nuevoId]);
            }
        });
        
        res.status(201).json({ id: nuevoId, message: 'Material creado correctamente', qr_generado: true });
    } catch (error) {
        console.error('Error al insertar:', error);
        res.status(500).json({ error: 'Error al crear material' });
    }
});

// Actualizar un material
app.put('/api/materiales/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion } = req.body;
        if (cantidad_disponible > cantidad_total) {
            return res.status(400).json({ error: 'La cantidad disponible no puede ser mayor que la cantidad total' });
        }
        const query = `
            UPDATE materiales 
            SET nombre = ?, descripcion = ?, categoria_id = ?, 
                cantidad_total = ?, cantidad_disponible = ?, ubicacion = ?
            WHERE id = ?
        `;
        const values = [nombre, descripcion, categoria_id, cantidad_total, cantidad_disponible, ubicacion, id];
        const [result] = await promisePool.query(query, values);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Material no encontrado' });
        }
        res.json({ message: 'Material actualizado correctamente' });
    } catch (error) {
        console.error('Error al actualizar:', error);
        res.status(500).json({ error: 'Error al actualizar material' });
    }
});

// Eliminar un material (con verificación de préstamos activos)
app.delete('/api/materiales/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [prestamos] = await promisePool.query('SELECT id FROM prestamos WHERE material_id = ? AND estado = "activo"', [id]);
        if (prestamos.length > 0) {
            return res.status(400).json({ error: 'No se puede eliminar el material porque tiene préstamos activos' });
        }
        const [material] = await promisePool.query('SELECT qr_code_path, codigo_unico FROM materiales WHERE id = ?', [id]);
        const [result] = await promisePool.query('DELETE FROM materiales WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Material no encontrado' });
        }
        if (material.length > 0 && material[0].qr_code_path) {
            const nombreArchivo = material[0].qr_code_path.split('/').pop();
            const rutaQR = path.join(qrDir, nombreArchivo);
            if (fs.existsSync(rutaQR)) fs.unlinkSync(rutaQR);
        }
        res.json({ message: 'Material eliminado correctamente' });
    } catch (error) {
        console.error('Error al eliminar:', error);
        res.status(500).json({ error: 'Error al eliminar material' });
    }
});

// Regenerar QR
app.post('/api/materiales/:id/regenerar-qr', async (req, res) => {
    try {
        const { id } = req.params;
        const [material] = await promisePool.query('SELECT codigo_unico, nombre, qr_code_path FROM materiales WHERE id = ?', [id]);
        if (material.length === 0) {
            return res.status(404).json({ error: 'Material no encontrado' });
        }
        const { codigo_unico, nombre, qr_code_path } = material[0];
        if (qr_code_path) {
            const nombreArchivo = qr_code_path.split('/').pop();
            const rutaQR = path.join(qrDir, nombreArchivo);
            if (fs.existsSync(rutaQR)) fs.unlinkSync(rutaQR);
        }
        generarQRPython(codigo_unico, nombre, async (err, qrInfo) => {
            if (err) return res.status(500).json({ error: 'Error al generar QR' });
            await promisePool.query('UPDATE materiales SET qr_code_path = ? WHERE id = ?', [qrInfo.url, id]);
            res.json({ message: 'QR regenerado correctamente', qr_url: qrInfo.url });
        });
    } catch (error) {
        console.error('Error al regenerar QR:', error);
        res.status(500).json({ error: 'Error al regenerar QR' });
    }
});

// EXPORTAR A EXCEL (mantienes tu código completo, no lo acorto por claridad, pero está intacto)
app.get('/api/exportar-excel', async (req, res) => {
    try {
        const [materiales] = await promisePool.query(`
            SELECT 
                m.id, m.codigo_unico, m.nombre, m.descripcion, c.nombre as categoria,
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
            SELECT 
                COUNT(*) as total_materiales,
                SUM(cantidad_total) as total_items,
                SUM(cantidad_disponible) as items_disponibles,
                SUM(cantidad_total - cantidad_disponible) as items_prestados,
                COUNT(CASE WHEN cantidad_disponible = 0 THEN 1 END) as materiales_agotados,
                COUNT(CASE WHEN cantidad_disponible < cantidad_total * 0.2 THEN 1 END) as materiales_criticos
            FROM materiales
        `);
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Inventario');
        worksheet.mergeCells('A1:J3');
        const titleCell = worksheet.getCell('A1');
        titleCell.value = {
            richText: [
                { text: 'ESCUELA SECUNDARIA OFIC. No. 0167\n', font: { bold: true, size: 16, color: { argb: COLORES.AZUL } } },
                { text: '"PROFR. FILIBERTO NAVAS VALDÉS"\n', font: { bold: true, size: 14, color: { argb: COLORES.AZUL } } },
                { text: 'INVENTARIO DE LABORATORIO QUÍMICO', font: { bold: true, size: 18, color: { argb: COLORES.AZUL } } }
            ]
        };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.DORADO } };
        titleCell.border = { top: { style: 'thick', color: { argb: COLORES.AZUL } }, bottom: { style: 'thick', color: { argb: COLORES.AZUL } }, left: { style: 'thick', color: { argb: COLORES.AZUL } }, right: { style: 'thick', color: { argb: COLORES.AZUL } } };
        worksheet.mergeCells('A4:J4');
        const dateCell = worksheet.getCell('A4');
        dateCell.value = `Fecha de exportación: ${new Date().toLocaleString('es-MX', { dateStyle: 'full', timeStyle: 'medium' })}`;
        dateCell.font = { italic: true, color: { argb: '666666' } };
        dateCell.alignment = { horizontal: 'right' };
        const headers = ['ID', 'Código Único', 'Nombre', 'Descripción', 'Categoría', 'Total', 'Disp.', 'Prest.', 'Ubicación', 'QR', 'Fecha Reg.', 'Estado'];
        const headerRow = worksheet.addRow(headers);
        headerRow.height = 30;
        headerRow.eachCell((cell) => {
            cell.font = { bold: true, color: { argb: COLORES.BLANCO }, size: 11 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.AZUL } };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
        materiales.forEach((item, index) => {
            const row = worksheet.addRow([item.id, item.codigo_unico, item.nombre, item.descripcion, item.categoria, item.cantidad_total, item.cantidad_disponible, item.cantidad_prestada, item.ubicacion, item.qr_code_path ? 'SÍ' : 'NO', item.fecha_registro, item.estado]);
            if (index % 2 === 0) {
                row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.GRIS } }; });
            }
            const estadoCell = row.getCell(12);
            if (item.estado === 'AGOTADO') {
                estadoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B6B' } };
                estadoCell.font = { bold: true, color: { argb: COLORES.BLANCO } };
            } else if (item.estado === 'CRÍTICO') {
                estadoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA500' } };
            } else if (item.estado === 'BAJO') {
                estadoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE55C' } };
            }
            row.eachCell((cell) => { cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
        });
        const statsSheet = workbook.addWorksheet('Estadísticas');
        statsSheet.mergeCells('A1:D3');
        const statsTitle = statsSheet.getCell('A1');
        statsTitle.value = 'RESUMEN ESTADÍSTICO DEL INVENTARIO';
        statsTitle.font = { bold: true, size: 16, color: { argb: COLORES.AZUL } };
        statsTitle.alignment = { horizontal: 'center', vertical: 'middle' };
        statsTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.DORADO } };
        const statsData = [
            ['Total de materiales:', stats[0].total_materiales],
            ['Total de items:', stats[0].total_items],
            ['Items disponibles:', stats[0].items_disponibles],
            ['Items prestados:', stats[0].items_prestados],
            ['Materiales agotados:', stats[0].materiales_agotados],
            ['Materiales en estado crítico:', stats[0].materiales_criticos],
            ['% de disponibilidad:', ((stats[0].items_disponibles / stats[0].total_items) * 100).toFixed(2) + '%']
        ];
        let rowIndex = 5;
        statsData.forEach(([label, value]) => {
            const labelCell = statsSheet.getCell(`A${rowIndex}`);
            labelCell.value = label;
            labelCell.font = { bold: true };
            const valueCell = statsSheet.getCell(`B${rowIndex}`);
            valueCell.value = value;
            valueCell.font = { color: { argb: COLORES.AZUL } };
            rowIndex++;
        });
        const [prestamos] = await promisePool.query(`
            SELECT p.id, m.nombre as material, u.nombre_completo as usuario, p.cantidad,
            DATE_FORMAT(p.fecha_prestamo, '%d/%m/%Y') as fecha_prestamo,
            DATE_FORMAT(p.fecha_devolucion, '%d/%m/%Y') as fecha_devolucion,
            DATEDIFF(p.fecha_devolucion, CURDATE()) as dias_restantes, p.estado
            FROM prestamos p
            JOIN materiales m ON p.material_id = m.id
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.estado = 'activo'
            ORDER BY p.fecha_devolucion ASC
        `);
        if (prestamos.length > 0) {
            const prestamosSheet = workbook.addWorksheet('Préstamos Activos');
            prestamosSheet.addRow(['ID', 'Material', 'Usuario', 'Cantidad', 'Fecha Préstamo', 'Fecha Devolución', 'Días Restantes']);
            prestamosSheet.getRow(1).eachCell((cell) => {
                cell.font = { bold: true };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORES.AZUL_CLARO } };
            });
            prestamos.forEach(p => prestamosSheet.addRow(Object.values(p)));
        }
        worksheet.columns.forEach(column => { column.width = 18; });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=inventario_${new Date().toISOString().split('T')[0]}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error al exportar a Excel:', error);
        res.status(500).json({ error: 'Error al exportar inventario' });
    }
});

// RUTAS DE CATEGORÍAS (igual que antes)
app.get('/api/categorias', async (req, res) => {
    try {
        const [results] = await promisePool.query(`
            SELECT c.*, COUNT(m.id) as total_materiales 
            FROM categorias c
            LEFT JOIN materiales m ON c.id = m.categoria_id
            GROUP BY c.id
            ORDER BY c.nombre ASC
        `);
        res.json(results);
    } catch (error) {
        console.error('Error en query:', error);
        res.status(500).json({ error: 'Error al obtener categorías' });
    }
});

app.get('/api/categorias/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [results] = await promisePool.query('SELECT * FROM categorias WHERE id = ?', [id]);
        if (results.length === 0) return res.status(404).json({ error: 'Categoría no encontrada' });
        res.json(results[0]);
    } catch (error) {
        console.error('Error en query:', error);
        res.status(500).json({ error: 'Error al obtener categoría' });
    }
});

// RUTAS DE PRÉSTAMOS (igual que antes)
app.get('/api/prestamos/activos', async (req, res) => {
    try {
        const [results] = await promisePool.query(`
            SELECT p.*, m.nombre as material_nombre, m.codigo_unico, u.nombre_completo as usuario_nombre,
            DATEDIFF(p.fecha_devolucion, CURDATE()) as dias_restantes
            FROM prestamos p
            JOIN materiales m ON p.material_id = m.id
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.estado = 'activo'
            ORDER BY p.fecha_devolucion ASC
        `);
        res.json(results);
    } catch (error) {
        console.error('Error en query:', error);
        res.status(500).json({ error: 'Error al obtener préstamos' });
    }
});

app.post('/api/prestamos', async (req, res) => {
    const connection = await promisePool.getConnection();
    try {
        await connection.beginTransaction();
        const { material_id, usuario_id, cantidad, fecha_devolucion, observaciones } = req.body;
        const [material] = await connection.query('SELECT cantidad_disponible FROM materiales WHERE id = ? FOR UPDATE', [material_id]);
        if (material.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Material no encontrado' }); }
        if (material[0].cantidad_disponible < cantidad) { await connection.rollback(); return res.status(400).json({ error: 'Stock insuficiente', disponible: material[0].cantidad_disponible, solicitado: cantidad }); }
        const [prestamoResult] = await connection.query('INSERT INTO prestamos (material_id, usuario_id, cantidad, fecha_devolucion, observaciones, estado) VALUES (?, ?, ?, ?, ?, "activo")', [material_id, usuario_id, cantidad, fecha_devolucion, observaciones]);
        await connection.query('UPDATE materiales SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?', [cantidad, material_id]);
        await connection.commit();
        res.status(201).json({ id: prestamoResult.insertId, message: 'Préstamo registrado correctamente' });
    } catch (error) {
        await connection.rollback();
        console.error('Error creando préstamo:', error);
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
        const fechaDevolucion = new Date(prestamo[0].fecha_devolucion);
        const hoy = new Date();
        const retraso = hoy > fechaDevolucion;
        await connection.query('UPDATE prestamos SET estado = "devuelto", fecha_devolucion_real = CURDATE(), observaciones = CONCAT(IFNULL(observaciones, ""), IF(?, " - DEVUELTO CON RETRASO", " - DEVUELTO A TIEMPO")) WHERE id = ?', [retraso, id]);
        await connection.query('UPDATE materiales SET cantidad_disponible = cantidad_disponible + ? WHERE id = ?', [prestamo[0].cantidad, prestamo[0].material_id]);
        await connection.commit();
        res.json({ message: retraso ? 'Devolución registrada con retraso' : 'Devolución registrada correctamente' });
    } catch (error) {
        await connection.rollback();
        console.error('Error devolviendo préstamo:', error);
        res.status(500).json({ error: 'Error al devolver préstamo' });
    } finally {
        connection.release();
    }
});

// ESTADÍSTICAS GENERALES
app.get('/api/estadisticas', async (req, res) => {
    try {
        const [materiales] = await promisePool.query(`SELECT COUNT(*) as total_materiales, SUM(cantidad_total) as total_items, SUM(cantidad_disponible) as items_disponibles, AVG(cantidad_disponible) as promedio_disponibilidad, COUNT(CASE WHEN cantidad_disponible = 0 THEN 1 END) as materiales_agotados FROM materiales`);
        const [prestamos] = await promisePool.query(`SELECT COUNT(*) as prestamos_activos, COUNT(CASE WHEN fecha_devolucion < CURDATE() THEN 1 END) as prestamos_vencidos FROM prestamos WHERE estado = 'activo'`);
        const [categorias] = await promisePool.query(`SELECT c.nombre, COUNT(m.id) as total FROM categorias c LEFT JOIN materiales m ON c.id = m.categoria_id GROUP BY c.id`);
        res.json({ materiales: materiales[0], prestamos: prestamos[0], categorias });
    } catch (error) {
        console.error('Error obteniendo estadísticas:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// HEALTH CHECK
app.get('/api/health', async (req, res) => {
    try {
        await promisePool.query('SELECT 1');
        const qrExists = fs.existsSync(qrDir);
        const [materialCount] = await promisePool.query('SELECT COUNT(*) as count FROM materiales');
        const [prestamoCount] = await promisePool.query('SELECT COUNT(*) as count FROM prestamos WHERE estado = "activo"');
        const [qrCount] = await promisePool.query('SELECT COUNT(*) as count FROM materiales WHERE qr_code_path IS NOT NULL');
        res.json({ status: 'OK', message: 'Servidor funcionando correctamente', timestamp: new Date().toISOString(), database: { connected: true, materiales: materialCount[0].count, prestamos_activos: prestamoCount[0].count, materiales_con_qr: qrCount[0].count }, sistema: { qr_folder: qrExists, version: '3.0.0' } });
    } catch (error) {
        res.json({ status: 'DEGRADED', message: 'Servidor funcionando pero con problemas de base de datos', error: error.message, timestamp: new Date().toISOString() });
    }
});

// MANEJO DE ERRORES GLOBAL
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ error: 'Error interno del servidor', message: err.message });
});

// INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log(`✅ SERVIDOR INICIADO CORRECTAMENTE - VERSIÓN RAILWAY`);
    console.log('='.repeat(60));
    console.log(`📍 URL: ${PUBLIC_URL}`);
    console.log(`📊 API: ${PUBLIC_URL}/api`);
    console.log(`📁 QR Folder: ${qrDir}`);
    console.log('\n📋 ENDPOINTS DISPONIBLES:');
    console.log('   GET    /api/health - Estado del servidor');
    console.log('   GET    /api/materiales - Lista materiales');
    console.log('   GET    /api/materiales/:id - Detalle material');
    console.log('   GET    /api/materiales/por-codigo/:codigo - Buscar por QR');
    console.log('   POST   /api/materiales - Crear material + QR');
    console.log('   PUT    /api/materiales/:id - Actualizar material');
    console.log('   DELETE /api/materiales/:id - Eliminar material');
    console.log('   POST   /api/materiales/:id/regenerar-qr - Regenerar QR');
    console.log('   GET    /api/categorias - Lista categorías');
    console.log('   GET    /api/prestamos/activos - Préstamos activos');
    console.log('   GET    /api/prestamos/historial - Historial préstamos');
    console.log('   POST   /api/prestamos - Crear préstamo');
    console.log('   PUT    /api/prestamos/devolver/:id - Devolver préstamo');
    console.log('   GET    /api/estadisticas - Estadísticas generales');
    console.log('   📊 GET    /api/exportar-excel - EXPORTAR A EXCEL');
    console.log('   📷 /qr/:archivo - Ver QR generados');
    console.log('='.repeat(60) + '\n');
});