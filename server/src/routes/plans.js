const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { success, fail } = require('../utils/response');

router.get('/plans', async (req, res, next) => {
    try {
        const { rows } = await db.query(
            `SELECT plan, display_name, quota_monthly, max_products, max_images,
                    max_templates, can_export, can_resume, custom_sites, team_sharing,
                    price_monthly, price_yearly, currency
             FROM plan_config ORDER BY
             CASE plan WHEN 'free' THEN 1 WHEN 'pro' THEN 2 WHEN 'enterprise' THEN 3 END`
        );
        success(res, rows);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
