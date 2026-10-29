# Comunidad JUMP — puesta en marcha

Guía para dejar funcionando la plataforma de JUMP en `https://www.laauroraescucha.com/jump/comunidad/`.
Son diez pasos, en este orden. Los pasos 1 a 5 dejan la plataforma lista para enseñarla con datos de ejemplo; el 6 y el 7 conectan Zoom; del 8 al 10 son para antes de usarla con personas reales y para cuidarla después.

**Regla de oro:** las llaves (`service_role`, secretos de Zoom, `JUMP_SECRET`) se pegan **solo** en Vercel. No van en el código, no van en el chat, no van en un correo.

JUMP tiene su **propio proyecto de Supabase**, separado del de La Aurora Escucha. No comparten base de datos, cuentas ni llaves. Nada de lo que hagas aquí toca La Aurora.

> **Ahora mismo JUMP está cerrado al público.** Quien entra a `/jump/` o a `/jump/comunidad/` ve «Sitio en construcción» (`/en-construccion/`), y no se reciben postulaciones ni votos. Para abrirlo de nuevo, en un cambio aparte:
> 1. borrar de `vercel.json` las dos redirecciones a `/en-construccion/`;
> 2. borrar de `.vercelignore` el bloque de JUMP (`/api/jump-postular.js` y `/api/jump-publico.js`);
> 3. borrar `tests/jump/cerrado.test.mjs` (comprueba que JUMP sigue cerrado).
>
> La base de datos, las cuentas y las variables de Vercel no se tocan: al abrir, todo sigue como estaba.
> Mientras está cerrado tampoco corre el borrado de las huellas del voto público (lo dispara cada visita a la página); con la primera visita después de abrir se borran todas las que ya cumplieron sus 30 días.

---

## 1. Crear el proyecto de Supabase de JUMP

1. Entra a [supabase.com](https://supabase.com), a la **misma organización** donde está el proyecto de La Aurora, y pulsa **New project**.
2. Nómbralo `jump` (o como prefieras), elige la región más cercana y guarda la contraseña de la base de datos en tu gestor de contraseñas.
3. Cuando termine de crearse, ve a **Authentication → Sign In / Providers** y **apaga** «Allow new users to sign up». Las cuentas las crea el equipo desde su panel; nadie debe poder registrarse solo.
4. En esa misma pantalla, en **Email**, deja **encendido** «Confirm email».
5. Ve a **Project Settings → API** y copia a un lugar privado tres cosas:
   - **Project URL** (`https://xxxxxxxx.supabase.co`) — este dato no es secreto.
   - **anon / publishable key** — pública por diseño.
   - **service_role key** — **secreta**. No la compartas con nadie.

## 2. Crear las tablas

1. En el proyecto de JUMP abre **SQL Editor → New query**.
2. Pega **todo** el archivo `supabase/jump/0001_comunidad_jump.sql` y pulsa **Run**.
3. En otra consulta nueva pega **todo** `supabase/jump/0002_postulaciones.sql` y pulsa **Run**. Crea la tabla de las postulaciones que llegan desde el formulario «Postula» de la página de JUMP (`/jump/`); el equipo las ve en **Postulaciones**.
4. En otra consulta nueva pega **todo** `supabase/jump/0003_encuestas.sql` y pulsa **Run**. Crea las encuestas: la **Encuesta del mes** que los emprendedores votan y proponen en la comunidad, y que cualquiera puede votar en la página de JUMP (`/jump/`). El equipo las maneja en **Encuestas**. Sin este paso, JC y todo lo demás funcionan igual, pero no aparece ninguna encuesta y **Encuestas** avisa que falta la migración.
5. Las tres se pueden correr más de una vez sin problema. Deben terminar con «Success».

> No lo pegues en el proyecto de La Aurora Escucha. Debe ir en el proyecto de JUMP.

## 3. Crear el primer administrador

El equipo entra con su **correo real y su clave**, como en cualquier sitio (puede ser un correo personal). Los emprendedores, en cambio, entran con su cédula.

1. **Authentication → Users → Add user → Create new user**:
   - Email: el correo real de quien va a administrar.
   - Password: la clave que vaya a usar.
   - Marca **Auto Confirm User**.
2. En **SQL Editor → New query** corre **solo esto**, cambiando `EL_CORREO` (el mismo del punto anterior) y `TU NOMBRE`. Es la plantilla de la sección «9. PRIMER ADMIN DE JUMP» al final de `supabase/jump/0001_comunidad_jump.sql`:

   ```sql
   insert into public.jump_miembros (user_id, rol, usuario, nombres, correo, debe_cambiar_clave)
   select id, 'admin', 'admin.jump', 'TU NOMBRE', email, false from auth.users
    where email = 'EL_CORREO';
   ```
3. Esa persona ya puede entrar como **Equipo JUMP** (paso 5) y agregar al resto del equipo desde **Ajustes → Agregar persona del equipo** (con el correo real de cada una).

## 4. Variables en Vercel y dirección de la base en la CSP

1. En Vercel: tu proyecto → **Settings → Environment Variables**. Crea estas cinco para **Production**:

   | Variable | Qué lleva |
   |---|---|
   | `JUMP_SUPABASE_URL` | el Project URL del paso 1 |
   | `JUMP_SUPABASE_ANON_KEY` | la anon / publishable key |
   | `JUMP_SUPABASE_SERVICE_ROLE_KEY` | la service_role key (secreta) |
   | `JUMP_SECRET` | un texto aleatorio de 32 caracteres o más (ver abajo) |
   | `JUMP_PUBLIC_URL` | `https://www.laauroraescucha.com` (sin barra al final) |

   Para generar `JUMP_SECRET`, en una terminal: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Si algún día lo cambias, la cuenta de Zoom conectada deja de servir y hay que conectarla de nuevo.

   Estas variables **no** tienen respaldo en las de La Aurora: si falta una, JUMP se niega a funcionar (así nunca cae en la base equivocada).

2. **La dirección de la base en la CSP.** El navegador solo puede hablar con la base de JUMP si su dirección está en la política de seguridad (CSP). **Ya está puesta** para el proyecto `https://yibbjwpitawmfnrnyjek.supabase.co` (`JUMP_SUPABASE_HOST` en `scripts/csp.mjs`, y `vercel.json` ya regenerado), así que con ese proyecto no tienes que hacer nada aquí.

   Solo si algún día usas **otro** proyecto de Supabase: cambia `JUMP_SUPABASE_HOST` en `scripts/csp.mjs` por su Project URL y, en una terminal dentro de la carpeta del proyecto:

   ```bash
   node scripts/csp.mjs
   ```

   Eso regenera `vercel.json`. Comprueba con `node scripts/csp.mjs --check` (debe decir «CSP al día.»), sube los cambios a GitHub y haz **Redeploy** en Vercel.

   Si esa dirección no coincide con tu proyecto, la pantalla de entrada carga pero no puede conectarse a ninguna base.

## 5. Entrar y cargar los datos de ejemplo

1. Abre `https://www.laauroraescucha.com/jump/comunidad/`, pulsa **Equipo JUMP** e ingresa con el correo y la clave del paso 3.
2. Ve a **Ajustes → Datos de ejemplo → Cargar datos de ejemplo**. Se crean personas, mentorías, módulos, clases, avisos y publicaciones **de mentira**, para poder enseñar la plataforma completa.
3. Mientras existan, el panel muestra una franja que dice «Hay datos de ejemplo cargados» con el botón **Borrar ejemplos**.

## 6. Crear la app de Zoom (en la cuenta de Zoom de JUMP)

Hazlo con la cuenta de Zoom que usará JUMP para sus clases, en [marketplace.zoom.us](https://marketplace.zoom.us) → **Develop → Build App**:

1. Tipo **General App**, administrada por el usuario (**User-managed**).
2. **OAuth Redirect URL** y lista de permitidos (**OAuth allow list**): `https://www.laauroraescucha.com/api/jump-zoom-callback` (exacta, sin espacios).
3. **Permisos (scopes):** crear reuniones (`meeting:write:meeting`) y ver el perfil de la cuenta (`user:read:user`). Si el panel de Zoom te muestra los permisos clásicos, son `meeting:write` y `user:read`.
4. **Event Subscriptions** → activa los eventos → agrega el evento **App Deauthorized** con esta URL: `https://www.laauroraescucha.com/api/jump-zoom-deauth`. Copia el **Secret Token** que te muestra Zoom. (Pulsa **Validate** solo después de haber hecho el Redeploy del paso 7 con las variables puestas.)
5. En Vercel agrega tres variables más y haz **Redeploy**:

   | Variable | Qué lleva |
   |---|---|
   | `ZOOM_CLIENT_ID` | el Client ID de la app |
   | `ZOOM_CLIENT_SECRET` | el Client Secret (secreto) |
   | `ZOOM_WEBHOOK_SECRET` | el Secret Token de los eventos (secreto) |

## 7. Conectar Zoom

1. En la plataforma: **Ajustes → Cuenta de Zoom → Conectar Zoom**.
2. Zoom te pide autorizar la app; acepta con la cuenta de JUMP (la misma donde creaste la app; con otra cuenta Zoom no deja crear las reuniones).
3. Al volver, Ajustes dice «Zoom quedó conectado» y «Conectada como …» con el correo de la cuenta. Desde ahí, el panel crea las reuniones de las clases en vivo.
4. Si un día quieres usar otra cuenta de Zoom: **Cambiar cuenta**. Si quieres quitar la conexión: **Desconectar**.

Si en Ajustes aparece «Zoom todavía no está configurado en el servidor», faltan `ZOOM_CLIENT_ID` o `ZOOM_CLIENT_SECRET` en Vercel (o falta el Redeploy).

## 8. Antes de meter datos reales

1. **Josué revisa la política de privacidad** (`jump/comunidad/privacidad.html`): es lo primero que aceptan las personas al entrar por primera vez, y la plataforma guarda cédula, WhatsApp y fotos.
2. **Borra los datos de ejemplo:** **Ajustes → Datos de ejemplo → Borrar ejemplos**. Te cuenta qué se va a borrar y te pide escribir `BORRAR`. Solo borra lo que está marcado como ejemplo; no toca nada real.
3. Agrega al resto del equipo en **Ajustes → Agregar persona del equipo** y a cada emprendedor(a) en **Emprendedores → Agregar emprendedor**. Te muestra una clave temporal **una sola vez**: cópiala y envíasela por WhatsApp; al entrar por primera vez la persona crea la suya.

## 9. Una nota sobre las clases en Zoom

Las cuentas gratuitas de Zoom cortan las reuniones de más de **2 personas a los 40 minutos**. Si las clases duran más, hace falta un plan de pago en la cuenta de Zoom de JUMP (o planear la clase en dos tramos). No es un fallo de la plataforma.

## 10. Cuidar el espacio gratis

El plan gratis de Supabase da **1 GB** de archivos por proyecto. Lo que ocupa espacio:

- **Videos: nada.** No se suben: se pega el enlace de YouTube o Vimeo y se ven dentro de la plataforma.
- **Fotos del muro y portadas:** se reducen solas al subirlas (máximo 1600 px, WebP) y pesan unos cientos de KB.
- **Imágenes del material adicional:** también se reducen solas (máximo 2000 px, WebP). Si la reducida no queda más liviana, se sube la original.
- **PDF, Word, Excel y PowerPoint:** se suben tal cual (hasta 20 MB cada uno); en el navegador no se pueden recomprimir sin dañarlos. Si uno pesa mucho, comprímelo antes de subirlo.

**Ajustes → Espacio del material** muestra cuánto material llevas subido contra el gigabyte gratis y avisa al pasar del 70 % y del 90 %. No cuenta las fotos del muro; el uso total lo ves en el panel de Supabase (**Usage**).

---

## Si algo no funciona

| Qué ves | Qué revisar |
|---|---|
| La pantalla de entrada dice que no se puede conectar | Faltan las variables `JUMP_*` en Vercel, o no hiciste el Redeploy (paso 4). |
| La entrada carga pero «Entrar» no hace nada y la consola del navegador habla de «Content Security Policy» | Falta cambiar `JUMP_SUPABASE_HOST` en `scripts/csp.mjs` y regenerar `vercel.json` (paso 4.2). |
| «Correo o clave incorrecta.» con el admin recién creado | Revisa que marcaste **Auto Confirm User**, que corriste el `insert` del paso 3 con el mismo correo y que lo escribes igual que en **Authentication → Users**. |
| Al agregar un emprendedor, Supabase responde `email_address_invalid` | El equipo usa su correo real; los emprendedores entran con su cédula y, como Supabase pide un correo por cuenta, cada uno lleva uno interno (`c<cédula>@laauroraescucha.com`) que nadie lee ni recibe mensajes. Si Supabase rechazara ese formato, avísale a quien mantiene el sitio: se cambia en una línea (`DOMINIO_CEDULA` en `jump/comunidad/js/cedula.js`). Eso no se pudo probar contra un Supabase real, solo contra el simulado. |
| **Postulaciones** dice «Las postulaciones todavía no están activadas», o el formulario de `/jump/` responde «No se pudo enviar» | Falta correr `supabase/jump/0002_postulaciones.sql` en el proyecto de JUMP (paso 2.3). |
| **Encuestas** dice «Falta aplicar la migración 0003», o la página de JUMP dice «Pronto abriremos la primera encuesta» aunque ya abriste una | Falta correr `supabase/jump/0003_encuestas.sql` en el proyecto de JUMP (paso 2.4), o la encuesta está en borrador: ábrela desde **Encuestas**. La página de JUMP guarda lo que muestra hasta minuto y medio: una encuesta recién abierta aparece al rato. |
| Una persona nueva dice que su cuenta está suspendida | Está suspendida en **Emprendedores**; reactívala desde ahí. |
| Zoom: «No se pudo conectar Zoom. Intenta de nuevo.» | Revisa que la OAuth Redirect URL de la app de Zoom sea idéntica a `…/api/jump-zoom-callback` y que `JUMP_PUBLIC_URL` no tenga barra al final. |
| Las pruebas de seguridad | `docs/loanix/SECURITY.md`, sección «Comunidad JUMP», lista cada caso de abuso con su prueba. |
