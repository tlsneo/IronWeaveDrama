export const baseCharacterBoard = {
  aspectRatio: '16:9',
  prompt: `Professional adult character identity and base-body reference sheet.
Generate an image only, with no text reply.

ADULT-ONLY SCOPE:
This template is exclusively for characters explicitly described as adults
aged 18 or older. Do not apply this underwear base-body template to minors
or characters whose age is ambiguous.

PURPOSE:
Create a neutral production reference sheet of the supplied adult character
for consistent facial identity, hairstyle, body shape and anatomical
proportions before later costume design.

Use the supplied character description only for:
- adult age;
- facial identity and recognizable facial features;
- skin tone;
- hairstyle and hair color;
- natural body shape and proportions;
- explicitly requested art style.

For this base-body stage, ignore all costume, uniform, armor, robe, footwear,
jewelry, decorative hair accessories, weapons, equipment and props mentioned
in the supplied character description. Do not render those elements.
They will be designed and generated separately in a later stage.

OUTPUT:
Generate exactly ONE horizontal 16:9 image on a single canvas.

Use a solid pure-white background only:
RGB 255,255,255.

Do not create a 2×2 grid, a second row, a poster, a comic page or an
overlapping photo collage.

EXACT LAYOUT:
Arrange exactly four visual sections in ONE horizontal row from left to right:

1. FRONTAL FACE CLOSE-UP.
2. FRONT FULL-BODY VIEW.
3. LEFT-FACING SIDE FULL-BODY VIEW.
4. BACK FULL-BODY VIEW.

Approximate section widths:
- Frontal face close-up: 34% of the canvas.
- Front full-body view: 22% of the canvas.
- Side full-body view: 22% of the canvas.
- Back full-body view: 22% of the canvas.

The face close-up section must be visibly wider than each individual
full-body section.

Keep every depiction completely inside its assigned section.
No face, body part, hair, clothing or shadow may cross into an adjacent section.

These section names are instructions only.
Do NOT print section names, labels or any other text in the generated image.

FRONTAL FACE CLOSE-UP:
- Show the same adult character looking directly at the viewer.
- Use a perfectly straight-on frontal view.
- Keep the head level and centered.
- Use a neutral, natural and relaxed expression.
- Both eyes must be clearly visible and looking directly toward the viewer.
- Include the complete head silhouette, top of the hair, hairline, ears
  where naturally visible, cheeks, jawline and chin.
- Do not cut off the top of the head or hairstyle.
- Crop at the upper neck or immediately below the chin.
- Do not include the shoulders, chest or torso.
- Make the face as large and clearly readable as possible inside the
  left section.
- Preserve natural skin texture and recognizable facial characteristics.
- Do not beautify, idealize or redesign the character.
- Do not change the character's described adult age.
- Do not create a three-quarter face or side-facing face.

For long hair:
- Show only the portion of the hair naturally visible inside the face section.
- Do not extend the hair into adjacent sections.
- Show the complete hair length and hairstyle in the three full-body views.

FRONT FULL-BODY VIEW:
- Show exactly one complete figure of the same adult character.
- The character must face directly toward the viewer.
- Keep the head, eyes, shoulders, chest, torso, hips, knees and feet
  facing straight forward.
- Show the complete figure from the top of the head to the soles of the feet.
- Do not crop the head, hands, legs or feet.
- Use a neutral anatomical standing pose.
- Keep the spine upright and the shoulders naturally level.
- Keep both arms relaxed and slightly separated from the torso.
- Keep both hands fully visible with relaxed fingers.
- Keep both legs straight and naturally spaced.
- Place both feet flat and parallel on the same baseline.
- Do not use an action pose, fashion pose, contrapposto pose or seductive pose.
- The visible face must clearly match the frontal face close-up.

LEFT-FACING SIDE FULL-BODY VIEW:
- Show exactly one complete figure of the same adult character.
- Use a strict 90-degree full-body side profile facing screen left.
- Keep the head, nose, shoulders, torso, hips, knees, legs and feet
  facing the same left direction.
- Show the complete figure from the top of the head to the soles of the feet.
- Do not crop the head, hands, legs or feet.
- Show only the visible-side eye.
- Do not expose the far-side eye.
- Do not turn the head toward the viewer.
- Do not use a three-quarter angle.
- Preserve the same neutral standing posture used in the front view.
- Keep both arms naturally lowered without obscuring the body silhouette.
- Preserve exactly the same height, body shape and anatomical proportions
  as the front full-body view.
- The visible eye, nose profile, lips, jawline, ear and hairstyle must
  clearly belong to the same character shown in the frontal face close-up.
- Do not depict a sibling, alternate version or different model.

BACK FULL-BODY VIEW:
- Show exactly one complete figure of the same adult character.
- Use a strict rear view rotated exactly 180 degrees from the front view.
- Keep the head and the entire body facing directly away from the viewer.
- Show the back of the head, complete hairstyle, neck, shoulders, back,
  waist, hips, legs, heels and feet.
- Show the complete figure from the top of the head to the soles of the feet.
- Do not crop the head, hands, legs or feet.
- Do not show any facial features.
- No eyes, eyebrows, nose, lips, chin or front of the face may be visible.
- Do not turn the head or look over the shoulder.
- Do not use a three-quarter back angle.
- Preserve exactly the same neutral standing posture, height, body shape
  and anatomical proportions as the front and side full-body views.

IDENTITY CONSISTENCY:
- All four sections must depict exactly the same adult character.
- Do not generate four different people.
- Do not generate siblings, variants, doubles or alternate versions.
- Preserve the same adult age, facial structure, eye shape, nose shape,
  lip shape, jawline, skin tone, hairstyle, hair color and identifying features.
- Preserve freckles, scars, birthmarks or other facial features only when
  they are explicitly included in the supplied character description.
- Do not change ethnicity, facial identity, apparent age or gender presentation
  between sections.
- Do not redesign or beautify the face.
- Keep facial identity recognizable across the frontal face close-up,
  front full-body view and side full-body view.
- The back view must use the same hairstyle, hair length and head shape.

BODY-PROPORTION CONSISTENCY:
- The front, side and back full-body views must have exactly the same
  apparent height and body proportions.
- Align the tops of their heads on the same horizontal line.
- Align the soles of their feet on the same horizontal baseline.
- Preserve the same shoulder width, torso length, waist position, hip width,
  arm length, leg length and overall body build.
- The side and back views must look like physically correct rotations of
  the front view.
- Use anatomy appropriate to the selected art style.
- Avoid unintended anatomical distortion.
- Do not exaggerate muscles, breasts, waist, hips, buttocks or other
  sexual characteristics beyond the supplied adult character description.

NEUTRAL BASE CLOTHING:
Use only plain, opaque, non-patterned, neutral light-gray model underwear.

For an adult woman:
- Use a simple, modest and non-decorative sports bra.
- Use matching high-waisted boyshorts.
- Keep the chest and all intimate areas fully covered.
- Do not use lace, transparent fabric, decorative lingerie, push-up shaping
  or revealing cuts.

For an adult man:
- Use simple, opaque and non-patterned fitted boxer briefs.
- Keep the torso naturally uncovered.
- Keep all intimate areas fully covered.
- Do not use transparent fabric, decorative underwear or revealing cuts.

For every character:
- Use exactly the same base clothing in the front, side and back views.
- Keep the base clothing fitted closely enough to show natural body
  proportions without sexualized styling.
- Do not use outer clothing, costumes, uniforms, robes, armor or coats.
- Do not add shoes, boots or socks.
- Keep the character barefoot in all three full-body views.
- Do not add jewelry or decorative hair accessories.
- A plain and visually unobtrusive hair tie or fastening may be used only
  when strictly necessary to preserve the described hairstyle.
- Do not add weapons, equipment, bags, tools or props.

LIGHTING AND COLOR:
- Use soft, neutral and even studio lighting.
- Use the same lighting direction and intensity across all four sections.
- Keep skin tone, hair color and base-clothing color consistent across all views.
- Avoid dramatic rim lighting, colored lighting, hard shadows or cinematic
  scene lighting that obscures anatomy.
- Use only subtle foot-contact shadows when necessary.
- Do not create large cast shadows behind the figures.

BACKGROUND AND PRESENTATION:
- Use only a solid pure-white background: RGB 255,255,255.
- Do not add scenery, architecture, furniture, floor texture, horizon line
  or decorative background elements.
- Keep spacing compact while clearly separating all four sections.
- Very thin pale-gray vertical separators are optional.
- Do not use thick borders, heavy frames or boxed comic panels.
- Do not overlap any figures.
- Do not place any object behind or in front of the character.

STRICT EXCLUSIONS:
- No title bar.
- No printed character name.
- No panel titles.
- No labels, captions, numbers or annotations.
- No letters, words, symbols or other printed text.
- No costume-detail panel.
- No suit-detail panel.
- No material or texture notes.
- No fabric samples.
- No color swatches.
- No footwear panel.
- No weapon or equipment panel.
- No signature-prop panel.
- No environment or narrative scene.
- No action pose.
- No glamour pose.
- No seductive pose.
- No three-quarter full-body view.
- No additional face close-up.
- No side-profile face close-up.
- No duplicated view.
- No additional figure.
- Exactly one frontal face close-up and exactly three full-body views.
- No 2×2 grid.
- No second row.
- No poster composition.
- No comic layout.
- No overlapping collage.
- No watermark.
- No logo.

ART STYLE:
Follow any ART STYLE / 画风 / MANDATORY ART STYLE instruction supplied
at the beginning of the user prompt.

Apply exactly the same art style, rendering technique, line quality,
surface treatment and level of realism to:
- the frontal face close-up;
- the front full-body view;
- the side full-body view;
- the back full-body view.

Do not force photorealism when a different art style is explicitly requested.
Do not mix photography, illustration, anime, painting or 3D rendering styles
within the same reference sheet.`,
};
