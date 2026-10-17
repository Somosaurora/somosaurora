# PROJECT — Somos Aurora

## Producto
- **Nombre:** Somos Aurora — "Tu voz sí importa".
- **Propósito:** Espacio de escucha ciudadana para los habitantes de **La Aurora (Daule, Ecuador)**. Permite a los vecinos enviar propuestas, quejas/problemas y otros temas; el equipo los analiza y publica un informe periódico con los temas más importantes.
- **Problema que resuelve:** Hoy no hay un canal ordenado para recoger, clasificar y dar visibilidad a las necesidades de la comunidad. Las opiniones se pierden y la comunidad no se siente escuchada.
- **Usuarios objetivo:**
  - *Público* — vecinos de La Aurora que envían opiniones (anónimo opcional; nombre y celular opcionales).
  - *Administrador* — el equipo de Somos Aurora (1–2 personas) que revisa, analiza, genera el informe semanal y gestiona la base.
- **Mercado / contexto:** Iniciativa comunitaria/política local. No comercial. Sin cobro a usuarios.
- **Tipo de producto:** Sitio web público (landing + formulario) + panel administrativo privado.
- **SaaS:** No. Es una aplicación de un solo tenant (una comunidad, un equipo admin).
- **Visibilidad:** Landing y top de opiniones **públicos**; panel y datos crudos **privados**.

## Alcance v1
- Guardar cada opinión del formulario en base de datos con **fecha y hora**.
- Panel admin con **tabla tipo Excel** (todos los campos + timestamp), filtros y **exportar CSV**.
- **Informe semanal** por **frecuencia/categoría** (sin IA): conteos por tema y sector + selección del **top 5–10** de opiniones destacadas.
- Botón **"Archivar y limpiar"**: guarda el informe + el top (persistentes) y **purga** las opiniones crudas de la semana.
- La web pública muestra el **top de la semana** en vivo (sección "Opiniones recientes").
- Despliegue en **Cloudflare**.

## Fuera de alcance v1
- Clustering semántico con IA (se evaluará en v2).
- Notificaciones automáticas al ciudadano (celular se guarda, pero no hay envío de SMS/WhatsApp todavía).
- Multi-comunidad / multi-tenant.
- Generación automática del reel (el top alimenta el guion; el video se produce aparte).
