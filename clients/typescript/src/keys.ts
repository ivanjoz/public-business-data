/**
 * The dataset keys, which are also the folders their year files live in.
 *
 * Their own module because both the manifest layer and the dataset layer need them, and putting
 * them in either one would make the other import it back.
 */

export const SUNAT_USD_PEN = 'sunat-usd-pen'
export const BCRP_INTERBANCARIO_USD_PEN = 'bcrp-interbancario-usd-pen'
