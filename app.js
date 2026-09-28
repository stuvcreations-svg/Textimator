<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roofing Estimate {{quote_number}}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap');
        
        body { 
            font-family: 'Montserrat', sans-serif; 
            background-color: #f4f7f6; 
            color: #2C3E50; 
            margin: 0; 
            padding: 40px; 
            -webkit-font-smoothing: antialiased;
        }
        .container { 
            max-width: 850px; 
            margin: auto; 
            background: #ffffff; 
            box-shadow: 0 10px 30px rgba(0,0,0,0.1); 
            border-radius: 8px; 
            overflow: hidden; 
        }
        .header-bar { 
            background-color: #182227; 
            color: #ffffff; 
            padding: 30px 40px; 
            border-bottom: 6px solid #d35400; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
        }
        .header-left { 
            font-size: 14px; 
            text-transform: uppercase; 
            color: #a0aab2; 
            letter-spacing: 1px; 
        }
        .header-left span { 
            color: #ffffff; 
            font-weight: 700; 
            font-size: 18px; 
            display: block; 
            margin-top: 5px; 
        }
        .header-right { 
            text-align: right; 
        }
        .header-right h1 { 
            margin: 0; 
            color: #d35400; 
            font-size: 22px; 
            text-transform: uppercase; 
            letter-spacing: 1.5px; 
        }
        .header-right p { 
            margin: 5px 0 0; 
            font-size: 12px; 
            color: #a0aab2; 
        }
        
        .content { padding: 40px; }
        
        .section-header { 
            font-size: 20px; 
            font-weight: 700; 
            color: #182227; 
            border-bottom: 2px solid #f0f0f0; 
            padding-bottom: 10px; 
            margin-bottom: 25px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
        }
        .section-header span { color: #d35400; }
        
        .grid-2 { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 30px; 
            margin-bottom: 40px; 
        }
        .data-block label { 
            display: block; 
            font-size: 11px; 
            color: #d35400; 
            text-transform: uppercase; 
            font-weight: 700; 
            letter-spacing: 1px; 
            margin-bottom: 8px; 
        }
        .data-block .val { 
            font-size: 15px; 
            line-height: 1.6; 
            color: #333333; 
            background: #fcfcfc; 
            padding: 12px; 
            border-left: 3px solid #182227; 
            border-radius: 0 4px 4px 0; 
        }
        
        .photos-section { margin-bottom: 40px; }
        .photos-grid { 
            display: flex; 
            flex-wrap: wrap; 
            gap: 15px; 
        }
        
        table { 
            width: 100%; 
            border-collapse: collapse; 
            margin-bottom: 40px; 
        }
        th { 
            text-align: left; 
            padding: 15px; 
            background-color: #182227; 
            color: #ffffff; 
            font-size: 12px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
        }
        td { 
            padding: 15px; 
            border-bottom: 1px solid #eee; 
            font-size: 14px; 
            color: #333333; 
        }
        tr:nth-child(even) td { background-color: #fafafa; }
        
        .pricing-block { 
            background-color: #182227; 
            color: #ffffff; 
            padding: 40px; 
            text-align: center; 
            border-radius: 8px; 
            border-top: 5px solid #d35400; 
        }
        .pricing-block h3 { 
            color: #d35400; 
            font-size: 16px; 
            text-transform: uppercase; 
            margin: 0 0 10px 0; 
            letter-spacing: 2px; 
        }
        .pricing-block .price { 
            font-size: 48px; 
            font-weight: 700; 
            margin: 0; 
        }
        .pricing-block p { 
            color: #a0aab2; 
            font-size: 13px; 
            margin-top: 15px; 
            text-transform: uppercase; 
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-bar">
            <div class="header-left">Estimate Number <span>{{quote_number}}</span></div>
            <div class="header-right">
                <h1>{{company_name}}</h1>
                <p>{{company_phone}} | {{company_email}}</p>
            </div>
        </div>
        
        <div class="content">
            <div class="section-header">Client & <span>Property</span></div>
            <div class="grid-2">
                <div class="data-block">
                    <label>Customer Details</label>
                    <div class="val">{{customer_name_and_address}}</div>
                </div>
                <div class="data-block">
                    <label>Building Type</label>
                    <div class="val">{{building_stories}}</div>
                </div>
                <div class="data-block">
                    <label>Quote Type</label>
                    <div class="val">{{insurance_or_retail}}</div>
                </div>
                <div class="data-block">
                    <label>Root Cause</label>
                    <div class="val">{{root_cause}}</div>
                </div>
            </div>

            <div class="section-header">Inspection <span>Findings</span></div>
            <div class="grid-2">
                <div class="data-block">
                    <label>Scope of Work</label>
                    <div class="val">{{scope_of_work}}</div>
                </div>
                <div class="data-block">
                    <label>Materials</label>
                    <div class="val">{{materials_current_and_new}}</div>
                </div>
                <div class="data-block">
                    <label>Site Notes</label>
                    <div class="val">{{site_notes}}</div>
                </div>
                <div class="data-block">
                    <label>Add-ons & Contingencies</label>
                    <div class="val">{{add_ons_and_contingencies}}</div>
                </div>
            </div>
            
            <div class="section-header">Photos & <span>Evidence</span></div>
            <div class="photos-section">
                <div class="photos-grid">{{roof_pictures}}</div>
            </div>

            <div class="section-header">Project <span>Terms</span></div>
            <table>
                <tr>
                    <th>Item</th>
                    <th>Description</th>
                </tr>
                <tr>
                    <td>Timeline</td>
                    <td>{{timeline}}</td>
                </tr>
                <tr>
                    <td>Payment Terms</td>
                    <td>{{payment_terms}}</td>
                </tr>
                <tr>
                    <td>Warranty</td>
                    <td>{{warranty_options}}</td>
                </tr>
            </table>

            <div class="pricing-block">
                <h3>Estimated Project Total</h3>
                <div class="price">{{total_price}}</div>
                <p>Valid until {{quote_valid_until}}</p>
            </div>
        </div>
    </div>
</body>
</html>
